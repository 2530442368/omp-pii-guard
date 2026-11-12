// 持久识别缓存：模型原始结果（RawFind[]）按 HMAC-SHA256(key, "pii-guard/find-cache/v1\0" + 模型修订 + "\0" + 文本)
// 存进 SQLite（bun:sqlite，WAL），让新启动的 omp 进程（例如 Tern 一次恢复很多会话）不必把同一批历史文本再推理一遍。
//
// 存什么：键（HMAC，不可逆推原文）、结果（位置、标签、分数，JSON）、最近使用日。**不存原文、原值、占位符。**
// 威胁模型：同一用户能改这个文件（例如写入空结果，让某段文本不被遮挡），与改 config.json 的 allow 同级，不防。
//
// 失败语义：任何缓存错误只表现为“未命中 → 照常推理”，绝不跳过遮挡、不抛给调用方。
// - 目录必须是自己的真实目录（ensureOwnDir，0700）；数据库及 -wal/-shm 为 0600；做不到就不启用缓存。
// - 读出的行逐项校验（整数位置、0 ≤ start < end ≤ text.length、标签合法、分数 0–1 的有限数），不合法当作未命中。
// - 写入合并成批（定时或攒够一批，一个事务），进程退出前尽力刷盘。
// - 条数有上限（默认 200 000），超出时按最近使用日淘汰到 90%；命中时只在使用日变了才更新。
// - 打不开或损坏（NOTADB/CORRUPT/版本不符/不是普通文件）：删除重建一次（纯派生数据）；仍不行则本进程禁用缓存。
//   “忙/锁”之类的错误不删库（别的进程正在用），只让本次操作失败；单次同步调用最多忙等 50 ms，打开时遇到忙/锁（很多进程同时首次创建）改为异步退避重试（预算 10 s，期间未命中、写入先暂存）。

import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LABELS } from "./guard.ts";
import { ensureOwnDir } from "./tern.ts";
import type { RawFind } from "./types.ts";

export interface FindCache {
  /** texts：masker 的 sha(text) → text。返回命中的 sha → 已校验的 finds。任何错误当作未命中，不抛。 */
  getMany(texts: ReadonlyMap<string, string>): Map<string, RawFind[]>;
  /** 记一条推理结果（合并后批量落盘）。错误只记 debug，不抛。 */
  put(text: string, finds: readonly RawFind[]): void;
  /** 立即写入未落盘的条目（测试与退出前用）。 */
  flush(): void;
  /** flush 后关闭；幂等。 */
  close(): void;
}

export interface FindCacheOptions {
  file: string;
  /** 取 HMAC 密钥（首次使用时才调用；抛错则这次当作未命中）。 */
  key: () => Buffer;
  /** 模型修订：进入键，换模型自动不命中。 */
  revision: string;
  /** 条数上限，默认 200 000。 */
  maxEntries?: number;
  debug?: (m: string) => void;
  /** 初始化遇忙时异步重试的总预算（毫秒，默认 10 000）；测试用。 */
  initBudgetMs?: number;
}

const KEY_PREFIX = "pii-guard/find-cache/v1\0";
const SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;
const DEFAULT_MAX = 200_000;
const BATCH = 200;
const FLUSH_MS = 3000;
const MAX_PENDING = 5000;
const CHUNK = 400;
const MAX_FAILURES = 5;
/** 单次同步 SQLite 调用的忙等上限：主线程被阻塞的时间以它为界（出口有 25 s 截止定时器，界面也在这个线程上）。 */
const BUSY_MS = 50;
const INIT_BUDGET_MS = 10_000;

const VALID_LABELS: ReadonlySet<string> = new Set(LABELS.filter((l) => l !== "O").map((l) => l.slice(2)));

const today = (): number => Math.floor(Date.now() / DAY_MS);

/** 校验一条 finds 是否可用于长度为 len 的文本；任何一项不合法返回 false。 */
function validFind(f: RawFind, len: number): boolean {
  return (
    Number.isInteger(f.start) &&
    Number.isInteger(f.end) &&
    f.start >= 0 &&
    f.start < f.end &&
    f.end <= len &&
    typeof f.label === "string" &&
    VALID_LABELS.has(f.label) &&
    typeof f.score === "number" &&
    Number.isFinite(f.score) &&
    f.score >= 0 &&
    f.score <= 1
  );
}

/** 解析并校验存储的 JSON（[[start, end, label, score], …]）；不合法返回 undefined。 */
export function parseFinds(json: unknown, len: number): RawFind[] | undefined {
  if (typeof json !== "string") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(v)) return undefined;
  const out: RawFind[] = [];
  for (const it of v) {
    if (!Array.isArray(it) || it.length !== 4) return undefined;
    const f: RawFind = { start: it[0], end: it[1], label: it[2], score: it[3] };
    if (!validFind(f, len)) return undefined;
    out.push(f);
  }
  return out;
}

class RebuildNeeded extends Error {}
/** 缓存目录或侧文件不安全（被换成符号链接、属主不对、权限收不紧）：本进程禁用缓存，不删任何东西。 */
class Unsafe extends Error {}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown): string => (e instanceof Error && "code" in e ? String(e.code) : "");

function isCorrupt(e: unknown): boolean {
  if (e instanceof RebuildNeeded) return true;
  const code = codeOf(e);
  if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT" || code.startsWith("SQLITE_CORRUPT_")) return true;
  return /not a database|malformed/i.test(msgOf(e));
}

/** 忙/锁（别的进程正在初始化或写入）。 */
function isBusy(e: unknown): boolean {
  const code = codeOf(e);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is locked|database is busy/i.test(msgOf(e));
}

/** 目录的身份（打开时记下），之后每次删库重建、重新打开前用 lstat 复核。 */
interface DirId {
  dir: string;
  dev: number;
  ino: number;
}

function dirIdOf(dir: string): DirId {
  const st = fs.lstatSync(dir);
  return { dir, dev: st.dev, ino: st.ino };
}

/** 目录必须仍是打开时记下的那个真实目录、属主是当前用户；否则抛 Unsafe（调用方禁用缓存，不删任何文件）。 */
function verifyDir(id: DirId): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(id.dir);
  } catch (e) {
    throw new Unsafe(`缓存目录无法核对：${msgOf(e)}`);
  }
  if (!st.isDirectory()) throw new Unsafe("缓存目录被换成了符号链接或其他类型");
  if (st.dev !== id.dev || st.ino !== id.ino) throw new Unsafe("缓存目录已不是打开时的那个目录");
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Unsafe("缓存目录的属主不是当前用户");
}

/**
 * 数据库及侧文件的唯一改动入口之二（另一个是 secureFile，再加 openDb 里的创建与 new Database）：
 * 动手前先核对目录身份，目录已被换掉就抛 Unsafe、不碰任何文件。
 */
function removeFiles(dir: DirId, file: string): void {
  verifyDir(dir);
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      fs.unlinkSync(f); // 符号链接只删链接本身
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/**
 * 保证文件是自己的、权限 0600 的普通文件，改权限不跟随符号链接（O_NOFOLLOW 打开后 fchmod，并核对 fd 与 lstat 是同一个 inode）。
 * 符号链接：只删链接本身（`strict` 时删完仍抛 Unsafe：它在数据库已打开之后才出现，说明有人在抢）；
 * 其他非普通文件抛 Unsafe。文件不存在是正常的（-wal/-shm 只在需要时才有）。
 */
function secureFile(dir: DirId, p: string, strict: boolean): void {
  verifyDir(dir); // 先核对目录身份：目录被换成指向别处的符号链接时，不能去改目标目录里的同名文件
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (codeOf(e) === "ENOENT") return;
    throw new Unsafe(`无法检查 ${path.basename(p)}：${msgOf(e)}`);
  }
  if (st.isSymbolicLink()) {
    fs.unlinkSync(p);
    if (strict) throw new Unsafe(`${path.basename(p)} 被换成了符号链接（已删除链接本身）`);
    return;
  }
  if (!st.isFile()) throw new Unsafe(`${path.basename(p)} 不是普通文件`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Unsafe(`${path.basename(p)} 的属主不是当前用户`);
  if ((st.mode & 0o777) === 0o600) return;
  try {
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s2 = fs.fstatSync(fd);
      if (!s2.isFile() || s2.dev !== st.dev || s2.ino !== st.ino) throw new Unsafe(`${path.basename(p)} 在检查期间被替换`);
      fs.fchmodSync(fd, 0o600);
      if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) throw new Unsafe(`${path.basename(p)} 权限无法收紧到 0600`);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    throw e instanceof Unsafe ? e : new Unsafe(`${path.basename(p)} 权限无法收紧到 0600：${msgOf(e)}`);
  }
}

const SIDES = ["-wal", "-shm"] as const;

/**
 * 打开（必要时创建）数据库并确认可用；同步、单次阻塞有界（busy_timeout 很小）。
 * 损坏类问题抛 isCorrupt 为真的错误；忙/锁抛 isBusy 为真的错误（调用方异步退避重试）；不安全抛 Unsafe。
 */
function openDb(file: string, dir: DirId): Database {
  // 打开前：数据库及侧文件里的符号链接只删链接本身（SQLite 会跟随链接读写）；其余检查与收紧权限。
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (codeOf(e) !== "ENOENT") throw e;
  }
  if (st) {
    if (!st.isFile()) throw new RebuildNeeded("缓存文件不是普通文件");
    secureFile(dir, file, false);
  } else {
    try {
      verifyDir(dir);
      fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 }); // 先以 0600 建好，-wal/-shm 继承它的权限
    } catch (e) {
      if (codeOf(e) !== "EEXIST") throw e;
    }
  }
  for (const s of [...SIDES, "-journal"]) secureFile(dir, file + s, false);
  verifyDir(dir); // SQLite 按路径打开并可能创建 -wal/-shm
  const db = new Database(file, { create: true, readwrite: true });
  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (ver === 0) {
      db.exec("CREATE TABLE IF NOT EXISTS finds(h BLOB PRIMARY KEY, v TEXT NOT NULL, day INTEGER NOT NULL) WITHOUT ROWID");
      db.exec("CREATE INDEX IF NOT EXISTS finds_day ON finds(day)");
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    } else if (ver !== SCHEMA_VERSION) {
      throw new RebuildNeeded("缓存版本不符");
    }
    db.prepare("SELECT h FROM finds LIMIT 1").all(); // 表结构不对或页损坏在这里暴露
    secureFile(dir, file, true);
    for (const s of SIDES) secureFile(dir, file + s, true);
    return db;
  } catch (e) {
    try {
      db.close();
    } catch {}
    throw e;
  }
}

class SqliteFindCache implements FindCache {
  private db: Database | undefined;
  /** 初始化中（第一次遇忙、等异步重试）：getMany 一律未命中，put 暂存。 */
  private initializing = false;
  private disabled = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private initDeadline = 0;
  private initTries = 0;
  private readonly pending = new Map<string, { h: Buffer; v: string }>();
  private readonly touched = new Map<string, Buffer>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** flush 失败后，put 触发的自动 flush 在此时刻之前不再尝试（显式 flush/close 照常尝试一次，各阻塞 ≤ busy_timeout）。 */
  private retryAt = 0;
  private key: Buffer | undefined;
  private count: number | undefined;
  /** 上次写事务里读到的 PRAGMA data_version：变了说明别的连接提交过，count 作废。 */
  private dataVersion: number | undefined;
  private rebuilt = false;
  private failures = 0;
  private readonly max: number;
  private readonly debug: (m: string) => void;
  private readonly initBudget: number;
  private readonly onExit = (): void => this.close();

  constructor(
    private readonly o: FindCacheOptions,
    private readonly dir: DirId,
  ) {
    this.max = Math.max(1, Math.floor(o.maxEntries ?? DEFAULT_MAX));
    this.debug = o.debug ?? (() => {});
    this.initBudget = o.initBudgetMs ?? INIT_BUDGET_MS;
    process.on("exit", this.onExit);
  }

  /** 第一次同步尝试；遇忙则转入异步重试。返回缓存是否还可用（false = 已禁用）。 */
  begin(): boolean {
    this.initDeadline = Date.now() + this.initBudget;
    this.attemptInit();
    return !this.disabled;
  }

  private attemptInit(): void {
    this.initTimer = undefined;
    if (this.disabled) return;
    this.initTries++;
    try {
      this.db = openDb(this.o.file, this.dir);
    } catch (e) {
      if (isBusy(e)) {
        const left = this.initDeadline - Date.now();
        if (left <= 0) return this.disable(`初始化 ${Math.round(this.initBudget / 1000)} s 内一直遇忙/锁`);
        this.initializing = true;
        const wait = Math.min(left, Math.min(1000, 50 * 2 ** Math.min(this.initTries, 5)) * (0.5 + Math.random()));
        this.debug(`pii-guard 识别缓存初始化遇忙，${Math.round(wait)} ms 后重试`);
        this.initTimer = setTimeout(() => this.attemptInit(), wait);
        this.initTimer.unref();
        return;
      }
      if (isCorrupt(e) && !this.rebuilt) {
        this.debug(`pii-guard 识别缓存损坏，删除重建：${msgOf(e)}`);
        this.rebuilt = true;
        try {
          removeFiles(this.dir, this.o.file);
        } catch (e2) {
          return this.disable(`重建失败：${msgOf(e2)}`);
        }
        return this.attemptInit();
      }
      return this.disable(isCorrupt(e) ? `损坏且已重建过一次：${msgOf(e)}` : `打不开：${msgOf(e)}`);
    }
    this.initializing = false;
    if (this.pending.size > 0 || this.touched.size > 0) this.schedule();
  }

  private hash(text: string): Buffer {
    this.key ??= this.o.key();
    return createHmac("sha256", this.key).update(KEY_PREFIX).update(this.o.revision).update("\0").update(text).digest();
  }

  getMany(texts: ReadonlyMap<string, string>): Map<string, RawFind[]> {
    const out = new Map<string, RawFind[]>();
    if (!this.db || texts.size === 0) return out;
    try {
      const want = new Map<string, { sha: string; text: string; h: Buffer }>();
      for (const [sha, text] of texts) {
        const h = this.hash(text);
        const hex = h.toString("hex");
        const p = this.pending.get(hex);
        if (p) {
          const f = parseFinds(p.v, text.length);
          if (f) out.set(sha, f);
        } else want.set(hex, { sha, text, h });
      }
      const entries = [...want.values()];
      const day = today();
      for (let i = 0; i < entries.length; i += CHUNK) {
        const part = entries.slice(i, i + CHUNK);
        const rows = this.db!.prepare(`SELECT h, v, day FROM finds WHERE h IN (${part.map(() => "?").join(",")})`).all(...part.map((e) => e.h)) as {
          h: Uint8Array;
          v: unknown;
          day: number;
        }[];
        for (const r of rows) {
          const hex = Buffer.from(r.h).toString("hex");
          const e = want.get(hex);
          if (!e) continue;
          const f = parseFinds(r.v, e.text.length);
          if (!f) continue; // 篡改/损坏的行：当作未命中，推理后会被覆盖
          out.set(e.sha, f);
          if (r.day !== day) this.stageTouch(hex, e.h);
        }
      }
      if (this.touched.size > 0) this.schedule();
      this.failures = 0;
    } catch (e) {
      this.fail(e);
    }
    return out;
  }

  private stageTouch(hex: string, h: Buffer): void {
    this.touched.set(hex, h);
    capOldest(this.touched);
  }

  put(text: string, finds: readonly RawFind[]): void {
    if (this.disabled) return;
    try {
      for (const f of finds) if (!validFind(f, text.length)) return; // 读出时也会被拒，不必存
      const v = JSON.stringify(finds.map((f) => [f.start, f.end, f.label, f.score]));
      const h = this.hash(text);
      const hex = h.toString("hex");
      this.pending.delete(hex);
      this.pending.set(hex, { h, v });
      capOldest(this.pending);
      if (this.db && this.pending.size >= BATCH && Date.now() >= this.retryAt) this.flush();
      else this.schedule();
    } catch (e) {
      this.fail(e);
    }
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disabled) {
      this.pending.clear();
      this.touched.clear();
      return;
    }
    if (!this.db) return; // 初始化中：暂存的等初始化完成后再写
    if (this.pending.size === 0 && this.touched.size === 0) return;
    const db = this.db;
    const rows = [...this.pending.values()];
    const touches = [...this.touched.values()];
    try {
      const day = today();
      db.exec("BEGIN IMMEDIATE");
      try {
        const ins = db.prepare("INSERT INTO finds(h, v, day) VALUES(?, ?, ?) ON CONFLICT(h) DO UPDATE SET v = excluded.v, day = excluded.day");
        for (const r of rows) ins.run(r.h, r.v, day);
        const upd = db.prepare("UPDATE finds SET day = ? WHERE h = ? AND day <> ?");
        for (const h of touches) upd.run(day, h, day);
        this.evict(db, rows.length);
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
      this.pending.clear();
      this.touched.clear();
      this.failures = 0;
      this.retryAt = 0;
      for (const s of SIDES) secureFile(this.dir, this.o.file + s, true); // -wal/-shm 此时才可能新建：核对不是链接、权限 0600
    } catch (e) {
      this.count = undefined;
      this.retryAt = Date.now() + FLUSH_MS;
      this.fail(e);
      if (!this.disabled && this.db && (this.pending.size > 0 || this.touched.size > 0)) this.schedule(); // 忙/锁：保留这批，稍后重试
    }
  }

  /**
   * 在写事务内（已持有写锁，别的连接此刻不能提交）：超过上限时按最近使用日淘汰到 90%。
   * count 只在“自上次写事务以来没有别的连接提交过”（data_version 没变）时累加，否则重数；
   * 重数是对 WITHOUT ROWID 表的一次扫描，只发生在别的进程写过之后，次数受 flush 频率（≥3 s 一次或攒够 200 条）限制。
   */
  private evict(db: Database, added: number): void {
    const exact = (): number => (db.prepare("SELECT count(*) AS c FROM finds").get() as { c: number }).c;
    const dv = (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    let n = this.count !== undefined && dv === this.dataVersion ? this.count + added : exact();
    this.dataVersion = dv;
    if (n > this.max) {
      n = exact();
      if (n > this.max) {
        const drop = n - Math.floor(this.max * 0.9);
        n -= db.prepare("DELETE FROM finds WHERE h IN (SELECT h FROM finds ORDER BY day ASC LIMIT ?)").run(drop).changes;
      }
    }
    this.count = n;
  }

  close(): void {
    if (this.disabled) return;
    try {
      this.flush();
    } catch {}
    this.disable();
  }

  private schedule(): void {
    if (this.timer || this.disabled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_MS);
    this.timer.unref();
  }

  /** 记 debug；损坏类错误删库重建一次，其余错误连续多次后禁用。永不抛。 */
  private fail(e: unknown): void {
    try {
      this.debug(`pii-guard 识别缓存出错（当作未命中）：${msgOf(e)}`);
      if (e instanceof Unsafe) return this.disable(msgOf(e));
      try {
        if (this.db) for (const s of SIDES) secureFile(this.dir, this.o.file + s, true); // 出错时顺带核对侧文件（被换成链接时 SQLite 自己也会报 I/O 错误）
      } catch (e2) {
        return this.disable(msgOf(e2));
      }
      if (isCorrupt(e)) return this.recover();
      if (++this.failures >= MAX_FAILURES) this.disable("连续出错");
    } catch {}
  }

  private recover(): void {
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
    this.count = undefined;
    this.dataVersion = undefined;
    if (this.rebuilt) return this.disable("损坏且已重建过一次");
    this.rebuilt = true;
    try {
      removeFiles(this.dir, this.o.file);
    } catch (e) {
      return this.disable(`重建失败：${msgOf(e)}`);
    }
    this.initDeadline = Date.now() + this.initBudget;
    this.attemptInit();
  }

  /** 停用并释放（幂等）。why 给出时记一条 debug。 */
  private disable(why?: string): void {
    if (why) this.debug(`pii-guard 识别缓存本进程禁用：${why}`);
    this.disabled = true;
    this.initializing = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.initTimer);
    this.initTimer = undefined;
    process.off("exit", this.onExit);
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
    this.pending.clear();
    this.touched.clear();
  }
}

/** 超过暂存上限时丢最旧的（Map 按插入顺序）。 */
function capOldest(m: Map<string, unknown>): void {
  while (m.size > MAX_PENDING) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
}

/**
 * 打开持久识别缓存；任何原因打不开（含目录不安全）返回 undefined，调用方照常推理。不抛。
 * 第一次尝试是同步的、单次阻塞 ≤ 约 busy_timeout；遇到忙/锁（别的进程正在初始化）时先返回缓存对象，
 * 初始化在后台用定时器退避重试（总预算约 10 s，超了本进程禁用）：此前 getMany 一律未命中、put 暂存。
 */
export function openFindCache(opts: FindCacheOptions): FindCache | undefined {
  const debug = opts.debug ?? (() => {});
  let dir: DirId;
  try {
    const d = path.dirname(opts.file);
    ensureOwnDir(d);
    dir = dirIdOf(d);
  } catch (e) {
    debug(`pii-guard 识别缓存目录不可用，已停用：${msgOf(e)}`);
    return undefined;
  }
  try {
    const cache = new SqliteFindCache(opts, dir);
    return cache.begin() ? cache : undefined;
  } catch (e) {
    debug(`pii-guard 识别缓存打不开，已停用：${msgOf(e)}`);
    return undefined;
  }
}
