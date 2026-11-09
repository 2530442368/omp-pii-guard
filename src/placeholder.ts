// 占位符：{{KIND_xxxxxxxx}}，xxxxxxxx = base32 小写(HMAC-SHA256(key, kind + "\0" + value)) 的前 8 位（同 magpie）。
// 同值同占位符，保证提示缓存稳定；映射（占位符 → 原值）只存在内存里，经会话条目持久化（见 index.ts）。

import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALL_KINDS } from "./config.ts";
import type { Kind } from "./types.ts";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(buf: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of buf) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** 读密钥文件；不存在时生成 32 字节随机密钥并以 0600 写入（目录 0700）。内容不对时抛错，不覆盖。 */
export function loadKey(file: string): Buffer {
  try {
    return readKey(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" });
  } catch (e) {
    // 另一个进程刚好先写了：读它的
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return readKey(file);
    throw e;
  }
  return key;
}

/** 读已有密钥；权限不是 0600（放宽过、或被改成 0400/0700）一律改回 0600。 */
function readKey(file: string): Buffer {
  const buf = checkKey(fs.readFileSync(file), file);
  if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  return buf;
}

function checkKey(buf: Buffer, file: string): Buffer {
  if (buf.length !== 32) throw new Error(`密钥文件 ${file} 长度应为 32 字节，实际 ${buf.length}（不会自动覆盖，请检查或删除后重启）`);
  return buf;
}

export interface MapEntry {
  /** 完整占位符，如 {{PERSON_abcd1234}}。 */
  ph: string;
  value: string;
  /** 模型识别分数（0–1）；缺省（旧会话）按 1 处理。 */
  s?: number;
}

const normAllow = (allow: ReadonlySet<string>): Set<string> => new Set([...allow].map((a) => a.trim().toLowerCase()));

/** 文本里的占位符（全局正则，用 matchAll/replace，不要复用 lastIndex）。 */
export const PH_RE = /\{\{(PERSON|ADDRESS|PHONE|EMAIL|ACCOUNT|SECRET)_([a-z2-7]{8,32})\}\}/g;

/** 占位符表：原值 ↔ 占位符。进程内共享。 */
export class Placeholders {
  readonly byPh = new Map<string, string>();
  /** kind + "\0" + value → 占位符。 */
  private readonly byValue = new Map<string, string>();
  /** 值 → 类别（供 knownSpans；只放启用类别的值，由调用方过滤）。 */
  readonly known = new Map<string, Kind>();
  /** 占位符 → 最高识别分数；已知值按当前阈值过滤。 */
  private readonly scores = new Map<string, number>();
  /** 当前阈值：分数低于它的值不进已知值表（重新调高阈值后，旧的误报不再补遮）。 */
  private threshold = 0;
  /** 每放入新的已知值 +1：缓存的遮挡结果按它判断是否过期。 */
  gen = 0;
  private key: Buffer | undefined;

  constructor(private readonly getKey: () => Buffer) {}

  /** 取（必要时新建）value 在 kind 下的占位符。score 是模型识别分数（规则/补找的区间不带分数，按 1）。 */
  tag(kind: Kind, value: string, enabled: ReadonlySet<Kind>, score?: number): string {
    const id = `${kind}\0${value}`;
    const hit = this.byValue.get(id);
    if (hit !== undefined) {
      if (score !== undefined) this.noteScore(hit, score);
      this.makeKnown(kind, value, enabled, hit);
      return hit;
    }
    this.key ??= this.getKey();
    const digest = base32(createHmac("sha256", this.key).update(id).digest());
    let len = 8;
    let ph = `{{${kind}_${digest.slice(0, len)}}}`;
    // 8 位碰到别的值时加长（40 位下几乎不会发生）
    while (this.byPh.has(ph) && this.byPh.get(ph) !== value && len < 32) ph = `{{${kind}_${digest.slice(0, (len += 4))}}}`;
    this.byPh.set(ph, value);
    this.byValue.set(id, ph);
    this.noteScore(ph, score ?? 1);
    this.makeKnown(kind, value, enabled, ph);
    return ph;
  }

  private noteScore(ph: string, score: number): void {
    if (!((this.scores.get(ph) ?? -1) >= score)) this.scores.set(ph, score);
  }

  /** 占位符的识别分数（持久化用）。 */
  scoreOf(ph: string): number {
    return this.scores.get(ph) ?? 1;
  }

  /** 从持久化的条目恢复。类别取自占位符前缀。 */
  load(entries: readonly MapEntry[], enabled: ReadonlySet<Kind>, allow: ReadonlySet<string>): number {
    let n = 0;
    const allowed = normAllow(allow);
    for (const e of entries) {
      if (typeof e?.ph !== "string" || typeof e?.value !== "string") continue;
      const m = /^\{\{([A-Z]+)_[a-z2-7]{8,32}\}\}$/.exec(e.ph);
      if (!m || !(ALL_KINDS as readonly string[]).includes(m[1]!)) continue;
      const kind = m[1] as Kind;
      const score = typeof e.s === "number" && e.s >= 0 && e.s <= 1 ? e.s : 1;
      if (this.byPh.get(e.ph) === e.value) {
        // 同一占位符的重复条目（分数更新）：合并，取最高分
        const before = this.scoreOf(e.ph);
        this.noteScore(e.ph, score);
        if (this.scoreOf(e.ph) !== before && !allowed.has(e.value.trim().toLowerCase())) this.makeKnown(kind, e.value, enabled, e.ph);
        continue;
      }
      this.byPh.set(e.ph, e.value);
      this.byValue.set(`${kind}\0${e.value}`, e.ph);
      this.noteScore(e.ph, score);
      if (!allowed.has(e.value.trim().toLowerCase())) this.makeKnown(kind, e.value, enabled, e.ph);
      n++;
    }
    return n;
  }

  private makeKnown(kind: Kind, value: string, enabled: ReadonlySet<Kind>, ph: string): void {
    if (!enabled.has(kind) || this.known.has(value) || this.scoreOf(ph) < this.threshold) return;
    this.known.set(value, kind);
    this.gen++;
  }

  /** 配置（启用的类别、允许词、阈值）变了：按现有映射重建已知值表。 */
  rebuildKnown(enabled: ReadonlySet<Kind>, allow: ReadonlySet<string>, threshold: number): void {
    this.threshold = threshold;
    this.known.clear();
    const allowed = normAllow(allow);
    for (const [id, ph] of this.byValue) {
      const sep = id.indexOf("\0");
      const kind = id.slice(0, sep) as Kind;
      const value = id.slice(sep + 1);
      if (enabled.has(kind) && this.scoreOf(ph) >= threshold && !allowed.has(value.trim().toLowerCase()) && !this.known.has(value)) {
        this.known.set(value, kind);
      }
    }
    this.gen++;
  }

  /** 文本里已知的占位符换回原值；不认识的原样保留。 */
  restoreText(text: string): string {
    if (!text.includes("{{")) return text;
    return text.replace(PH_RE, (m) => this.byPh.get(m) ?? m);
  }

  /** 深度遍历，字符串叶子里的占位符换回原值；返回新对象，不改入参。skip 返回 true 的字符串叶子原样保留。 */
  restoreDeep<T>(v: T, skip?: (s: string) => boolean): { value: T; changed: boolean } {
    const st = { changed: false };
    return { value: this.walk(v, skip, st) as T, changed: st.changed };
  }

  /** 占位符对应的原值（不认识返回 undefined）。 */
  lookup(ph: string): string | undefined {
    return this.byPh.get(ph);
  }

  private walk(v: unknown, skip: ((s: string) => boolean) | undefined, st: { changed: boolean }): unknown {
    if (typeof v === "string") {
      if (skip?.(v)) return v;
      const r = this.restoreText(v);
      if (r !== v) st.changed = true;
      return r;
    }
    if (Array.isArray(v)) return v.map((x) => this.walk(x, skip, st));
    if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.walk(x, skip, st);
      return out;
    }
    return v;
  }
}

const normTool = (name: string): string => name.replace(/^_+/, "").toLowerCase();

/** 工具名通配（* 匹配任意串）；不分大小写。 */
function globMatch(patterns: readonly string[], name: string): boolean {
  for (const p of patterns) {
    const re = new RegExp(`^${p.toLowerCase().split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (re.test(name)) return true;
  }
  return false;
}

/**
 * 这个工具的参数会离开本机（第三方服务），不还原：web_search、generate_image、web_*、fetch*、browser*，
 * 以及全部 mcp__* 工具（外部服务；本地 MCP 用 allow（配置 restoreTools）放行）。extra（配置 noRestoreTools）优先于 allow。
 */
export function noRestoreTool(name: string, extra: readonly string[] = [], allow: readonly string[] = []): boolean {
  const n = normTool(name);
  if (globMatch(extra, n)) return true;
  if (n === "web_search" || n === "generate_image") return true;
  if (n.startsWith("web_") || n.startsWith("fetch") || n.startsWith("browser")) return true;
  if (n.startsWith("mcp__") && !globMatch(allow, n)) return true;
  return false;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
export const isUrl = (s: string): boolean => URL_RE.test(s);

/** 目标在本机的 URI scheme：参数照常还原。其他 scheme（ssh、http(s)、mcp、pr、issue……）按外部目标处理。 */
const LOCAL_SCHEMES = new Set(["local", "agent", "out", "artifact", "file", "skill", "history", "proc", "omp"]);
const TARGET_KEYS = ["path", "file_path", "uri", "url"] as const;

export interface RestoreConfig {
  noRestoreTools: readonly string[];
  restoreTools: readonly string[];
}

/**
 * 按工具名与调用目标给出还原策略：整个调用不还原返回 "all"；read 的 URL 叶子不还原（返回判断函数）；
 * 其余全部还原（undefined）。
 * 目标 = input.path / file_path / uri / url 里第一个字符串：
 * - `xd://<tool>`：按 <tool> 套用同一工具策略（write xd://mcp__… 即写 MCP 网关）；
 * - 本机 scheme 或没有 scheme 的路径：照常；其余 scheme：不还原。
 */
export function restorePolicy(toolName: string, input: unknown, cfg: RestoreConfig): "all" | ((s: string) => boolean) | undefined {
  if (noRestoreTool(toolName, cfg.noRestoreTools, cfg.restoreTools)) return "all";
  let target: string | undefined;
  if (input !== null && typeof input === "object") {
    for (const k of TARGET_KEYS) {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === "string") {
        target = v;
        break;
      }
    }
  }
  const m = target === undefined ? null : /^\s*([a-z][a-z0-9+.-]*):\/\/([^]*)$/i.exec(target);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    if (scheme === "xd") {
      let tool = /^[^/?#]*/.exec(m[2]!)![0];
      try {
        tool = decodeURIComponent(tool);
      } catch {
        /* 保持原样 */
      }
      if (tool === "" || noRestoreTool(tool, cfg.noRestoreTools, cfg.restoreTools)) return "all";
    } else if (!LOCAL_SCHEMES.has(scheme)) return "all";
  }
  return normTool(toolName) === "read" ? isUrl : undefined;
}
