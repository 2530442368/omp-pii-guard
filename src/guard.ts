// AstrLink Guard（QuantumNous/astrlink-guard，Apache-2.0）在 onnxruntime-node 上的推理。
// 流程对照 magpie internal/pii/guard/guard.go：510 token 窗口、重叠 128、BIO 解码、span 分数取其 token
// 的最小概率、低于 0.5（Floor）丢弃。tokenizers 给的偏移是 Unicode 码点下标，这里换算成 UTF-16 下标。

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GlobalSlots } from "./slots.ts";
import type { RawFind } from "./types.ts";

export const LABELS = [
  "O",
  "B-email", "I-email", "B-phone", "I-phone", "B-account", "I-account",
  "B-payment_card", "I-payment_card", "B-ip_address", "I-ip_address",
  "B-url", "I-url", "B-common_secret", "I-common_secret",
  "B-private_address", "I-private_address", "B-private_date", "I-private_date",
  "B-private_person", "I-private_person",
] as const;

const MAX_POS = 512;
const WINDOW = MAX_POS - 2;
const OVERLAP = 128;
const FLOOR = 0.5;

/** 模型文件（QuantumNous/astrlink-guard v0.1.3，修订 7216b6a3b897…，int8）。 */
export const MODEL_REVISION = "7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4";
export const MODEL_FILES: readonly { name: string; size: number; sha256: string }[] = [
  { name: "model_int8.onnx", size: 330781, sha256: "0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a" },
  { name: "model_int8.onnx_data", size: 37124608, sha256: "0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067" },
  { name: "tokenizer.json", size: 1502881, sha256: "0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4" },
];

export function modelUrl(file: string): string {
  return `https://huggingface.co/QuantumNous/astrlink-guard/resolve/${MODEL_REVISION}/int8/${file}`;
}

/** 校验模型目录：缺失、大小或 sha256 不符时抛带说明的错误。 */
export async function verifyModel(dir: string): Promise<void> {
  const problems: string[] = [];
  await Promise.all(
    MODEL_FILES.map(async (f) => {
      const p = path.join(dir, f.name);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(p);
      } catch {
        problems.push(`缺失 ${p}`);
        return;
      }
      if (st.size !== f.size) {
        problems.push(`${p} 大小 ${st.size} 与预期 ${f.size} 不符`);
        return;
      }
      const h = createHash("sha256");
      for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer);
      if (h.digest("hex") !== f.sha256) problems.push(`${p} 的 sha256 不符（文件损坏或被替换）`);
    }),
  );
  if (problems.length > 0) {
    throw new Error(`模型文件不可用：${problems.sort().join("；")}。在 omp 里运行 /pii setup 下载并校验模型（约 37 MB）`);
  }
}

/**
 * 一个限制并发的闸门；前台（出口请求）的等待排在后台（预扫描）前面。
 * 给了 global 时：拿到进程内名额后再取跨进程槽位（见 src/slots.ts），推理完先放跨进程槽位再交接进程内名额。
 */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly waitingBackground: (() => void)[] = [];
  constructor(
    readonly limit: number,
    private readonly global?: GlobalSlots,
  ) {}

  async run<T>(fn: () => Promise<T>, background = false): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => (background ? this.waitingBackground : this.waiting).push(resolve)); // 槽位由释放者直接交接
    try {
      let release: (() => void) | undefined;
      try {
        release = await this.global?.acquire(background);
      } catch {} // 契约上不抛；万一抛了也只退回进程内限流
      try {
        return await fn();
      } finally {
        release?.();
      }
    } finally {
      const next = this.waiting.shift() ?? this.waitingBackground.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** 识别器：对一段文本给出模型的原始结果。测试里可以换成假的。 */
export interface Recognizer {
  /** background：后台预扫描（让出给出口请求）。 */
  find(text: string, background?: boolean): Promise<RawFind[]>;
}

interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

export class AstrGuard implements Recognizer {
  private constructor(
    private readonly ort: { Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown },
    private readonly tokenizer: {
      encode(text: string, pair: string | null, opts: { addSpecialTokens: boolean }): Promise<{
        getIds(): number[];
        getOffsets(): [number, number][];
        getTokens(): string[];
      }>;
    },
    private readonly session: Session,
    private readonly bos: number,
    private readonly eos: number,
    private readonly limiter: Limiter,
    readonly threads: number,
  ) {}

  /** 校验并加载模型。concurrency：同时在跑的窗口数上限（全局限流）。 */
  static async load(dir: string, threads: number, limiter: Limiter): Promise<AstrGuard> {
    await verifyModel(dir);
    // 原生依赖按需动态加载（不能静态 import）：扩展入口要在没装依赖/没装模型时也能加载，
    // 这样 /pii 与失败提示仍然可用，而不是整个扩展加载失败。
    const ortMod = (await import("onnxruntime-node")) as Record<string, unknown>;
    const ort = (ortMod.default ?? ortMod) as {
      InferenceSession: { create(p: string, o: Record<string, unknown>): Promise<Session> };
      Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
    };
    const tokMod = (await import("@anush008/tokenizers")) as Record<string, unknown>;
    const tok = (tokMod.default ?? tokMod) as {
      Tokenizer: { fromFile(p: string): AstrGuard["tokenizer"] & { tokenToId(t: string): number | null; disableTruncation(): void } };
    };
    const tokenizer = tok.Tokenizer.fromFile(path.join(dir, "tokenizer.json"));
    tokenizer.disableTruncation();
    const session = await ort.InferenceSession.create(path.join(dir, "model_int8.onnx"), {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
      // 关掉 ORT 线程池的忙等：多个进程同时推理（Tern 批量恢复会话）时，空转的线程会把 CPU 占满。
      // 实测：6 进程 × 8 线程超订时，同样工作量 CPU 时间约降到 30%、墙钟约降到 30%；独占时无差别。
      extra: { session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
    });
    const bos = tokenizer.tokenToId("<s>");
    const eos = tokenizer.tokenToId("</s>");
    if (bos === null || eos === null) throw new Error("tokenizer.json 里没有 <s> 或 </s>");
    return new AstrGuard(ort, tokenizer, session, bos, eos, limiter, threads);
  }

  private async runWindow(ids: number[], background: boolean): Promise<{ lab: Uint8Array; prob: Float32Array }> {
    const n = ids.length + 2;
    const input = new BigInt64Array(n);
    const mask = new BigInt64Array(n).fill(1n);
    input[0] = BigInt(this.bos);
    input[n - 1] = BigInt(this.eos);
    for (let i = 0; i < ids.length; i++) input[i + 1] = BigInt(ids[i]!);
    const feeds: Record<string, unknown> = {};
    for (const name of this.session.inputNames) {
      if (name.includes("mask")) feeds[name] = new this.ort.Tensor("int64", mask, [1, n]);
      else if (name.includes("type")) feeds[name] = new this.ort.Tensor("int64", new BigInt64Array(n), [1, n]);
      else feeds[name] = new this.ort.Tensor("int64", input, [1, n]);
    }
    const out = await this.limiter.run(() => this.session.run(feeds), background);
    const logits = out[this.session.outputNames[0]!]!.data; // [1, n, L]
    const L = LABELS.length;
    const lab = new Uint8Array(ids.length);
    const prob = new Float32Array(ids.length);
    for (let t = 1; t < n - 1; t++) {
      let best = 0;
      let max = -Infinity;
      let sum = 0;
      for (let k = 0; k < L; k++) {
        const v = logits[t * L + k]!;
        if (v > max) {
          max = v;
          best = k;
        }
      }
      for (let k = 0; k < L; k++) sum += Math.exp(logits[t * L + k]! - max);
      lab[t - 1] = best;
      prob[t - 1] = 1 / sum;
    }
    return { lab, prob };
  }

  async find(text: string, background = false): Promise<RawFind[]> {
    if (text.length === 0) return [];
    const enc = await this.tokenizer.encode(text, null, { addSpecialTokens: false });
    const ids = enc.getIds();
    const offs = enc.getOffsets();
    const toks = enc.getTokens();
    if (ids.length === 0) return [];
    // 码点下标 → UTF-16 下标
    let u16: number[] | null = null;
    if (/[\uD800-\uDBFF]/.test(text)) {
      u16 = [];
      let i = 0;
      for (const ch of text) {
        u16.push(i);
        i += ch.length;
      }
      u16.push(i);
    }
    const at = (cp: number): number => (u16 ? u16[cp]! : cp);

    const lab = new Uint8Array(ids.length);
    const prob = new Float32Array(ids.length).fill(1);
    const depth = new Int32Array(ids.length).fill(-1);
    const starts: number[] = [];
    for (let s = 0; s < ids.length; s += WINDOW - OVERLAP) {
      starts.push(s);
      if (Math.min(ids.length, s + WINDOW) === ids.length) break;
    }
    const results = await Promise.all(starts.map((s) => this.runWindow(ids.slice(s, Math.min(ids.length, s + WINDOW)), background)));
    starts.forEach((s, w) => {
      const e = Math.min(ids.length, s + WINDOW);
      const r = results[w]!;
      for (let i = s; i < e; i++) {
        const d = Math.min(i - s, e - 1 - i); // 离窗口边缘越远越可信
        if (d > depth[i]!) {
          depth[i] = d;
          lab[i] = r.lab[i - s]!;
          prob[i] = r.prob[i - s]!;
        }
      }
    });

    const spans: RawFind[] = [];
    let cur: RawFind | null = null;
    for (let j = 0; j < ids.length; j++) {
      const a = at(offs[j]![0]);
      const b = at(offs[j]![1]);
      if (b <= a || toks[j] === "▁") continue; // 无文本的 token 不开始也不结束 span
      const tag = LABELS[lab[j]!]!;
      if (tag === "O") {
        cur = null;
        continue;
      }
      const kind = tag.slice(2);
      if (tag[0] === "B" || !cur || cur.label !== kind) {
        cur = { start: a, end: b, label: kind, score: prob[j]! };
        spans.push(cur);
      } else {
        cur.end = b;
        cur.score = Math.min(cur.score, prob[j]!);
      }
    }
    return spans.filter((x) => x.score >= FLOOR);
  }
}
