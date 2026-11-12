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
//   “忙/锁”之类的错误不删库（别的进程正在用），只让本次操作失败。

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

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isCorrupt(e: unknown): boolean {
  if (e instanceof RebuildNeeded) return true;
  const code = e instanceof Error && "code" in e ? String(e.code) : "";
  if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT" || code.startsWith("SQLITE_CORRUPT_")) return true;
  return /not a database|malformed/i.test(msgOf(e));
}

function removeFiles(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      fs.unlinkSync(f); // 符号链接只删链接本身
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

function chmodQuiet(f: string): void {
  try {
    fs.chmodSync(f, 0o600);
  } catch {}
}

/** 打开（必要时创建）数据库并确认可用；损坏类问题抛 isCorrupt 为真的错误。 */
function openDb(file: string): Database {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (st) {
    if (!st.isFile()) throw new RebuildNeeded("缓存文件不是普通文件");
    if ((st.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  } else {
    try {
      fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 }); // 先以 0600 建好，-wal/-shm 继承它的权限
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const db = new Database(file, { create: true, readwrite: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
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
    chmodQuiet(`${file}-wal`);
    chmodQuiet(`${file}-shm`);
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
  private readonly pending = new Map<string, { h: Buffer; v: string }>();
  private readonly touched = new Map<string, Buffer>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private key: Buffer | undefined;
  private count: number | undefined;
  private rebuilt = false;
  private failures = 0;
  private readonly max: number;
  private readonly debug: (m: string) => void;
  private readonly onExit = (): void => this.close();

  constructor(
    private readonly o: FindCacheOptions,
    db: Database,
    rebuilt: boolean,
  ) {
    this.db = db;
    this.rebuilt = rebuilt;
    this.max = Math.max(1, Math.floor(o.maxEntries ?? DEFAULT_MAX));
    this.debug = o.debug ?? (() => {});
    process.on("exit", this.onExit);
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
          if (r.day !== day) this.touched.set(hex, e.h);
        }
      }
      if (this.touched.size > 0) this.schedule();
      this.failures = 0;
    } catch (e) {
      this.fail(e);
    }
    return out;
  }

  put(text: string, finds: readonly RawFind[]): void {
    if (!this.db) return;
    try {
      for (const f of finds) if (!validFind(f, text.length)) return; // 读出时也会被拒，不必存
      const v = JSON.stringify(finds.map((f) => [f.start, f.end, f.label, f.score]));
      const h = this.hash(text);
      this.pending.set(h.toString("hex"), { h, v });
      if (this.pending.size >= BATCH) this.flush();
      else this.schedule();
    } catch (e) {
      this.fail(e);
    }
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.db) {
      this.pending.clear();
      this.touched.clear();
      return;
    }
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
    } catch (e) {
      this.count = undefined;
      if (this.pending.size > MAX_PENDING) this.pending.clear();
      if (this.touched.size > MAX_PENDING) this.touched.clear();
      this.fail(e);
      if (this.db && (this.pending.size > 0 || this.touched.size > 0)) this.schedule(); // 忙/锁：稍后重试
    }
  }

  /** 在事务内：超过上限时按最近使用日淘汰到 90%。count 是上界，超过上限才精确重数。 */
  private evict(db: Database, added: number): void {
    const exact = (): number => (db.prepare("SELECT count(*) AS c FROM finds").get() as { c: number }).c;
    let n = this.count === undefined ? exact() : this.count + added;
    if (n > this.max) {
      n = exact();
      if (n > this.max) {
        const drop = n - Math.floor(this.max * 0.9);
        db.prepare("DELETE FROM finds WHERE h IN (SELECT h FROM finds ORDER BY day ASC LIMIT ?)").run(drop);
        n = exact();
      }
    }
    this.count = n;
  }

  close(): void {
    if (!this.db) return;
    try {
      this.flush();
    } catch {}
    clearTimeout(this.timer);
    this.timer = undefined;
    process.off("exit", this.onExit);
    const db = this.db;
    this.db = undefined;
    this.pending.clear();
    this.touched.clear();
    try {
      db.close();
    } catch {}
  }

  private schedule(): void {
    if (this.timer) return;
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
      if (isCorrupt(e)) {
        this.recover();
        return;
      }
      if (++this.failures >= MAX_FAILURES) this.disable("连续出错");
    } catch {}
  }

  private recover(): void {
    const old = this.db;
    if (!old) return;
    try {
      old.close();
    } catch {}
    this.db = undefined;
    this.count = undefined;
    if (this.rebuilt) return this.disable("损坏且已重建过一次");
    this.rebuilt = true;
    try {
      removeFiles(this.o.file);
      this.db = openDb(this.o.file);
    } catch (e) {
      this.disable(`重建失败：${msgOf(e)}`);
    }
  }

  private disable(why: string): void {
    this.debug(`pii-guard 识别缓存本进程禁用：${why}`);
    clearTimeout(this.timer);
    this.timer = undefined;
    process.off("exit", this.onExit);
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
    this.pending.clear();
    this.touched.clear();
  }
}

/** 打开持久识别缓存；任何原因打不开（含目录不安全）返回 undefined，调用方照常推理。不抛。 */
export function openFindCache(opts: FindCacheOptions): FindCache | undefined {
  const debug = opts.debug ?? (() => {});
  try {
    ensureOwnDir(path.dirname(opts.file));
  } catch (e) {
    debug(`pii-guard 识别缓存目录不可用，已停用：${msgOf(e)}`);
    return undefined;
  }
  let rebuilt = false;
  let db: Database | undefined;
  try {
    db = openDb(opts.file);
  } catch (e) {
    if (!isCorrupt(e)) {
      debug(`pii-guard 识别缓存打不开，已停用：${msgOf(e)}`);
      return undefined;
    }
    debug(`pii-guard 识别缓存损坏，删除重建：${msgOf(e)}`);
    try {
      removeFiles(opts.file);
      rebuilt = true;
      db = openDb(opts.file);
    } catch (e2) {
      debug(`pii-guard 识别缓存重建失败，已停用：${msgOf(e2)}`);
      return undefined;
    }
  }
  return new SqliteFindCache(opts, db, rebuilt);
}
