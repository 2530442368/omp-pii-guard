// 遮挡管线：AstrLink Guard 推理 → modelSpans（阈值、修边、误报过滤）→ 同一请求内 knownSpans 补遮 →
// 剪掉与已有占位符（映射表里的 {{…}}、omp 的 $$…$$）相交的部分 → 生成占位符。识别结果按 sha256(文本) 缓存（LRU），
// 同一文本只推理一次；缓存键含 args（工具参数语境）与配置指纹。遮挡产出（有改动的）按同样的键记入缓存，
// 第二层（网络层）遇到时不重复推理。

import { createHash } from "node:crypto";
import type { FindCache } from "./cache.ts";
import type { Config } from "./config.ts";
import { modelSpans, normalizeSpans } from "./filters.ts";
import type { Recognizer } from "./guard.ts";
import { knownSpans } from "./known.ts";
import type { TextItem, TextMasker } from "./payload.ts";
import { Placeholders } from "./placeholder.ts";
import type { Kind, RawFind, Span } from "./types.ts";

export class MaskTimeout extends Error {
  constructor() {
    super("遮挡超过时限");
    this.name = "MaskTimeout";
  }
}

/** 按插入顺序淘汰最旧项的 LRU；weight 之和超过 maxWeight 或条数超过 maxEntries 时淘汰。 */
export class Lru<V> {
  private readonly map = new Map<string, { v: V; w: number }>();
  private weight = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
  ) {}

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V, w: number): void {
    const old = this.map.get(k);
    if (old) this.weight -= old.w;
    this.map.delete(k);
    this.map.set(k, { v, w });
    this.weight += w;
    while (this.map.size > this.maxEntries || this.weight > this.maxWeight) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.weight -= this.map.get(first.value)!.w;
      this.map.delete(first.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export const sha = (s: string): string => createHash("sha256").update(s).digest("base64url");

/** 太短，不值得处理（比最短的已知值还短）。 */
export const tooShort = (s: string): boolean => s.length < 2;

/** 一大段无空白的 base64/哈希样的串（二进制载荷）：不送模型推理（已知值补遮照做）。 */
export function isBlob(s: string): boolean {
  return s.length >= 1024 && /^[A-Za-z0-9+/_=-]+$/.test(s);
}

// omp Hide Secrets 占位符的严格格式：$$ + 可选「大写字母数字{1,32}_」+ 12 位 [0-9A-Z] + 可选「:单个大写字母」+ $$。
// 不符合的 $$…$$ 不保护（否则可以拿 $$<已知值>$$ 夹带真实敏感值）。符合格式的还要由调用方确认来源（isDollar）：
// 本地会话历史里字面出现过的（omp 本地存原值，只在发往模型时才混淆）不是 omp 生成的占位符，不保护。
const DOLLAR_SRC = String.raw`\$\$(?:[A-Z0-9]{1,32}_)?[0-9A-Z]{12}(?::[A-Z])?\$\$`;
const PROTECTED = new RegExp(String.raw`\{\{[A-Z]+_[a-z2-7]{6,}\}\}|${DOLLAR_SRC}`, "g");
const DOLLAR = new RegExp(DOLLAR_SRC, "g");
const DOLLAR_FULL = new RegExp(`^${DOLLAR_SRC}$`);

/** 文本里所有严格格式的 $$…$$（不管来源）。 */
export function dollarMatches(text: string): string[] {
  return text.includes("$$") ? (text.match(DOLLAR) ?? []) : [];
}

/**
 * 文本里已有的占位符所占的区间：omp Hide Secrets 的 $$…$$（严格格式且 isDollar 确认），以及本扩展映射表里
 * 确实存在的 {{…}}（isPh 判断；外形像占位符但不在映射表里的不保护，否则可以拿它夹带真实敏感值）。
 */
export function protectedRanges(text: string, isPh: (ph: string) => boolean, isDollar: (ph: string) => boolean): [number, number][] {
  if (!text.includes("{{") && !text.includes("$$")) return [];
  const out: [number, number][] = [];
  for (const m of text.matchAll(PROTECTED)) if (m[0].startsWith("$") ? isDollar(m[0]) : isPh(m[0])) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** 文本里被确认保护的 $$…$$ 的签名（进缓存键：同一文本在不同的确认状态下产出不同）。 */
function dollarKey(text: string, isDollar: (ph: string) => boolean): string {
  if (!text.includes("$$")) return "";
  const hit = new Set<string>();
  for (const m of text.matchAll(PROTECTED)) if (m[0].startsWith("$") && isDollar(m[0])) hit.add(m[0]);
  return hit.size === 0 ? "" : `|${[...hit].sort().join(",")}`;
}

/**
 * 模型常把整个 `$$<值>$$` 当成一个密码给出，而 modelSpans 会丢弃带 $$ 的区间（为的是不碰 omp 的占位符）。
 * 不被确认是 omp 占位符的（字面写下的）严格格式 `$$<值>$$`：去掉两侧的 $$，让里面的值照常过滤、登记。
 */
function unwrapLiteral(text: string, finds: readonly RawFind[], isDollar: (ph: string) => boolean): readonly RawFind[] {
  if (!text.includes("$$")) return finds;
  return finds.map((f) => {
    const s = text.slice(f.start, f.end);
    return DOLLAR_FULL.test(s) && !isDollar(s) ? { ...f, start: f.start + 2, end: f.end - 2 } : f;
  });
}

/** 从 span 里剪掉受保护的部分，保留其余（不整段丢弃）；剪完只剩空白的碎片丢弃。保持顺序与附加字段（score）。 */
export function trimProtected<S extends Span>(text: string, spans: readonly S[], prot: readonly [number, number][]): S[] {
  if (prot.length === 0) return spans.slice();
  const out: S[] = [];
  for (const s of spans) {
    let parts: [number, number][] = [[s.start, s.end]];
    for (const [a, b] of prot) {
      const next: [number, number][] = [];
      for (const [x, y] of parts) {
        if (y <= a || x >= b) next.push([x, y]);
        else {
          if (x < a) next.push([x, a]);
          if (y > b) next.push([b, y]);
        }
      }
      parts = next;
    }
    for (const [x, y] of parts) if (text.slice(x, y).trim() !== "") out.push({ ...s, start: x, end: y });
  }
  return out;
}

/** 带模型分数的区间（来自模型结果；规则/补找的区间没有）。 */
export type ScoredSpan = Span & { score?: number };

function withScores(spans: readonly Span[], finds: readonly RawFind[]): ScoredSpan[] {
  return spans.map((s) => {
    let best = 0;
    let score = 1;
    for (const f of finds) {
      const ov = Math.min(f.end, s.end) - Math.max(f.start, s.start);
      if (ov > best) {
        best = ov;
        score = f.score;
      }
    }
    return { ...s, score };
  });
}

interface Done {
  gen: number;
  out: string;
}

export interface MaskOptions {
  /** 绝对截止时间（Date.now() 毫秒）；超过抛 MaskTimeout，后台推理继续，结果进缓存。 */
  deadline?: number;
  /** 每个新遮挡的值调用（kind、占位符）；用于会话计数。 */
  onTag?: (kind: Kind, ph: string) => void;
  /** 严格格式的 $$…$$ 是 omp 生成的占位符吗（保护它）；缺省：都不是。 */
  isDollar?: (ph: string) => boolean;
}

export class Masker implements TextMasker {
  private readonly finds = new Lru<RawFind[]>(20000, 5_000_000);
  private readonly spans = new Lru<ScoredSpan[]>(20000, 5_000_000);
  private readonly done = new Lru<Done>(20000, 100_000_000);
  private readonly inflight = new Map<string, Promise<RawFind[]>>();
  /** 配置指纹：阈值/类别/允许词变了，缓存的 span 作废。 */
  private cfgKey = "";

  constructor(
    private readonly recognizer: () => Promise<Recognizer>,
    readonly ph: Placeholders,
    private readonly config: () => Config,
    /** 持久识别缓存（可能还没就绪或已停用，每次用时现取）；它的任何错误都只当作未命中。 */
    private readonly cache?: () => FindCache | undefined,
  ) {}

  /** 配置变了（session_start 重读 config.json 后调用）：重建已知值表，缓存作废。 */
  configChanged(): void {
    const c = this.config();
    this.cfgKey = sha(JSON.stringify([c.threshold, [...c.kinds].sort(), [...c.allow].sort()])).slice(0, 12);
    this.ph.rebuildKnown(c.kinds, c.allow, c.threshold);
  }

  /** 只推理、不生成输出：把文本的识别结果放进缓存（后台预扫描用）。 */
  async prescan(items: readonly TextItem[], opts: { deadline?: number } = {}): Promise<void> {
    const texts = new Map<string, string>();
    for (const it of items) if (!tooShort(it.text) && !isBlob(it.text)) texts.set(sha(it.text), it.text);
    await this.ensureFinds(texts, opts.deadline, true);
  }

  async maskTexts(items: readonly TextItem[], opts: MaskOptions = {}): Promise<string[]> {
    if (this.cfgKey === "") this.configChanged();
    const cfg = this.config();
    const out: string[] = items.map((it) => it.text);
    const isDollar = opts.isDollar ?? ((): boolean => false);
    const hashes: (string | undefined)[] = items.map((it) => (tooShort(it.text) ? undefined : sha(it.text)));
    const blob: boolean[] = items.map((it) => isBlob(it.text));
    const dollars: string[] = items.map((it) => dollarKey(it.text, isDollar));
    /** 缓存键：文本 + 语境（args）+ 配置指纹 + 受保护的 $$…$$。 */
    const keyOf = (i: number): string => `${hashes[i]}${items[i]!.args ? "a" : "t"}${this.cfgKey}${dollars[i]}`;

    for (let round = 0; round < 4; round++) {
      const gen = this.ph.gen;
      const pending: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const h = hashes[i];
        if (h === undefined) continue;
        const d = this.done.get(keyOf(i));
        if (d && d.gen === gen) {
          out[i] = d.out;
          continue;
        }
        pending.push(i);
      }
      if (pending.length === 0) return out;

      // 1) 推理（缓存命中的不再推理）
      const need = new Map<string, string>();
      for (const i of pending) if (!blob[i]) need.set(hashes[i]!, items[i]!.text);
      await this.ensureFinds(need, opts.deadline);

      // 2) 模型结果 → span（先剪掉与占位符相交的部分），值先全部登记（已知值表要在补遮之前收齐）
      const isPh = (p: string): boolean => this.ph.byPh.has(p);
      const model = new Map<number, ScoredSpan[]>();
      for (const i of pending) {
        const text = items[i]!.text;
        const sp = blob[i] ? [] : trimProtected(text, this.modelSpansFor(hashes[i]!, items[i]!, cfg, dollars[i]!, isDollar), protectedRanges(text, isPh, isDollar));
        model.set(i, sp);
        for (const s of sp) this.ph.tag(s.kind, text.slice(s.start, s.end), cfg.kinds, s.score);
      }
      if (this.ph.gen !== gen) continue; // 有新的已知值：之前判定“已遮挡”的文本要重新补遮，重来一轮（缓存让它很快）

      // 3) 已知值补遮，替换
      for (const i of pending) {
        const text = items[i]!.text;
        // 已知值补遮不受占位符保护影响（受保护区间里命中已知值照遮）
        const cand = [...model.get(i)!, ...this.knownFor(text)];
        const result = this.apply(text, normalizeSpans(text, cand, cfg.allow) as ScoredSpan[], cfg, opts);
        out[i] = result;
        this.done.set(keyOf(i), { gen, out: result }, result.length + 64);
        if (result !== text) {
          // 有改动的产出：同语境下再遇到它（第二层）不用重新识别；已有的真实结果不覆盖
          const k = `${sha(result)}${items[i]!.args ? "a" : "t"}${this.cfgKey}${dollarKey(result, isDollar)}`;
          if (this.done.get(k) === undefined) this.done.set(k, { gen, out: result }, result.length + 64);
        }
      }
      return out;
    }
    throw new Error("已知值表持续变化，遮挡未能收敛");
  }

  private knownFor(text: string): Span[] {
    return this.ph.known.size === 0 ? [] : knownSpans(text, this.ph.known);
  }

  private modelSpansFor(h: string, it: TextItem, cfg: Config, dk: string, isDollar: (ph: string) => boolean): ScoredSpan[] {
    const key = `${h}${it.args ? "a" : "t"}${this.cfgKey}${dk}`;
    const hit = this.spans.get(key);
    if (hit) return hit;
    const raw = this.finds.get(h);
    if (!raw) throw new Error("内部错误：识别结果不在缓存里");
    const finds = unwrapLiteral(it.text, raw, isDollar);
    const sp = withScores(modelSpans(it.text, finds, { args: it.args, threshold: cfg.threshold, kinds: cfg.kinds, allow: cfg.allow }), finds);
    this.spans.set(key, sp, 64 + sp.length * 24);
    return sp;
  }

  private apply(text: string, spans: readonly ScoredSpan[], cfg: Config, opts: MaskOptions): string {
    if (spans.length === 0) return text;
    let res = "";
    let at = 0;
    for (const s of spans) {
      const value = text.slice(s.start, s.end);
      const ph = this.ph.tag(s.kind, value, cfg.kinds, s.score);
      res += text.slice(at, s.start) + ph;
      at = s.end;
      opts.onTag?.(s.kind, ph);
    }
    return res + text.slice(at);
  }

  /** 当前可用的持久缓存；取不到或出错一律当作没有。 */
  private persistent(): FindCache | undefined {
    try {
      return this.cache?.();
    } catch {
      return undefined;
    }
  }

  /**
   * 保证 texts（sha → 文本）都在识别缓存里：内存未命中且不在飞行中的先批量查持久缓存，命中的放进内存，
   * 其余推理（推理完成后写回持久缓存，调用方超时后在后台完成的也写）。超过 deadline 抛 MaskTimeout。
   */
  private async ensureFinds(texts: ReadonlyMap<string, string>, deadline: number | undefined, background = false): Promise<void> {
    const waits: Promise<unknown>[] = [];
    const todo = new Map<string, string>();
    for (const [h, text] of texts) {
      if (this.finds.get(h) !== undefined) continue;
      const p = this.inflight.get(h);
      if (p) waits.push(p);
      else todo.set(h, text);
    }
    if (todo.size > 0) {
      const cache = this.persistent();
      if (cache) {
        try {
          for (const [h, r] of cache.getMany(todo)) {
            this.finds.set(h, r, 100 + r.length * 40);
            todo.delete(h);
          }
        } catch {} // 缓存出错：当作未命中，照常推理
      }
    }
    let recognizer: Recognizer | undefined;
    for (const [h, text] of todo) {
      const p = (async () => {
        recognizer ??= await this.recognizer();
        const r = await recognizer.find(text, background);
        this.finds.set(h, r, 100 + r.length * 40);
        try {
          this.persistent()?.put(text, r);
        } catch {}
        return r;
      })();
      this.inflight.set(h, p);
      const clear = (): void => {
        this.inflight.delete(h);
      };
      p.then(clear, clear); // 也吞掉后台失败（调用方超时后没人再等它）
      waits.push(p);
    }
    if (waits.length === 0) return;
    if (deadline === undefined) {
      await Promise.all(waits);
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new MaskTimeout();
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    const t = setTimeout(() => reject(new MaskTimeout()), left);
    try {
      await Promise.race([Promise.all(waits), timeout]);
    } finally {
      clearTimeout(t);
    }
  }
}
