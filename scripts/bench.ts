// 基准：速度（冷加载、单窗口、各内容类型、出口遮挡、已知值补遮）与效果（合成标注语料召回、公开代码语料误遮）。
// 默认只用公开、可复现的语料：固定种子的合成文本（scripts/bench-corpus.ts）、`npm ci` 装出来的 node_modules
// 里的依赖源码、本仓库的 src/；不读任何私有目录。输出 Markdown 表（stdout），并可选写 JSON。
//
//   bun scripts/bench.ts [all|speed|effect|sweep]        （没有 Bun 时：BUN_BE_BUN=1 <omp 二进制> run scripts/bench.ts …）
//     all     默认：下面全部，THREADS 线程（默认 4）
//     speed   只测速度
//     effect  只测效果
//     sweep   线程扫描：对 1/2/4/8 线程各起一个子进程（冷加载、单窗口、各类型 ms/KB、预扫描 500 KB）
//
// 环境变量：
//   THREADS              ONNX Runtime 线程数，默认 4（和默认配置 min(4, 核数/2) 在 8 核以上机器上一致）
//   PII_GUARD_MODEL_DIR  模型目录；缺省依次试 PII_GUARD_DIR/model（默认 ~/.omp/agent/pii-guard/model）、magpie 缓存
//   PII_BENCH_JSON       把结果写成 JSON 文件（路径）
//   PII_BENCH_SEED       合成语料的种子，默认 20260101
//   PII_BENCH_PER_KIND   合成语料每个（语言，类别）的值个数，默认 100
//   PII_BENCH_REPS       重复次数（取中位数），默认 3
//   PII_BENCH_DIRS       可选：自有代码目录（多个用 ":" 分隔），只输出形状与计数，不打印真实值
//   PII_BENCH_SESSIONS   可选：omp 会话目录（各含 .jsonl，取名字排序最后一个），只输出形状与计数

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { delimiter, extname, join, relative } from "node:path";
import { defaultConfig, paths } from "../src/config.ts";
import { modelSpans } from "../src/filters.ts";
import { AstrGuard, Limiter, type Recognizer } from "../src/guard.ts";
import { knownSpans } from "../src/known.ts";
import { Masker } from "../src/mask.ts";
import { maskPayload } from "../src/payload.ts";
import { PH_RE, Placeholders } from "../src/placeholder.ts";
import type { Kind, RawFind, Span } from "../src/types.ts";
import { annotated, background, jsonToolOutput, rng, type Lang } from "./bench-corpus.ts";

const ROOT = join(import.meta.dir, "..");
const HOME = os.homedir();
const THREADS = Number(process.env.THREADS ?? 4);
const SEED = Number(process.env.PII_BENCH_SEED ?? 20260101);
const PER_KIND = Number(process.env.PII_BENCH_PER_KIND ?? 100);
const REPS = Number(process.env.PII_BENCH_REPS ?? 3);
const mode = process.argv[2] ?? "all";
const cfg = defaultConfig();

function modelDir(): string {
  const cands = [process.env.PII_GUARD_MODEL_DIR, paths().modelDir, join(HOME, ".cache/magpie/astrlink-guard/7216b6a3b897")].filter((x): x is string => !!x);
  const dir = cands.find((d) => existsSync(join(d, "model_int8.onnx")));
  if (!dir) throw new Error(`找不到模型：先在 omp 里运行 /pii setup，或用 PII_GUARD_MODEL_DIR 指定（试过：${cands.join("、")}）`);
  return dir;
}

// ---- 小工具 ---------------------------------------------------------------------------------------

const kb = (texts: readonly string[]): number => texts.reduce((n, t) => n + Buffer.byteLength(t), 0) / 1024;
/** 中位数：偶数个样本取中间两项的平均。 */
const median = (xs: number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
};
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)]!;
const f = (x: number, d = 1): string => x.toFixed(d);
const pct = (a: number, b: number): string => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`);
const mb = (bytes: number): number => bytes / 1048576;
const out: Record<string, unknown> = {};

function table(headers: string[], rows: (string | number)[][]): string {
  const line = (r: (string | number)[]): string => `| ${r.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}
const heading = (s: string): void => console.log(`\n### ${s}\n`);

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

/** 把已有的识别结果当识别器（用来单独测过滤/替换的耗时，或在同一份结果上做各种统计）。 */
const replay = (m: Map<string, RawFind[]>): Recognizer => ({ find: async (t) => m.get(t) ?? [] });

const newMasker = (rec: Recognizer): Masker => new Masker(async () => rec, new Placeholders(() => Buffer.alloc(32, 9)), () => cfg);

// ---- 公开语料 -------------------------------------------------------------------------------------

interface Doc {
  src: string;
  text: string;
}

const SKIP_DIR = /^(\.git|\.idea|build|dist|target|vendor|test|tests|__tests__)$/;

function walk(dir: string, files: string[], exts: Set<string>, maxBytes: number): void {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIR.test(name)) walk(p, files, exts, maxBytes);
    } else if (exts.has(extname(name)) && st.size > 300 && st.size < maxBytes) files.push(p);
  }
}

function readDocs(dir: string, exts: string[], maxBytes: number, label: (p: string) => string): Doc[] {
  const files: string[] = [];
  walk(dir, files, new Set(exts), maxBytes);
  return files.map((p) => ({ src: label(p), text: readFileSync(p, "utf8") }));
}

/** node_modules 里的依赖源码与文档（`npm ci` 按锁文件装出来，所以可复现）。 */
const depCode = (): Doc[] => readDocs(join(ROOT, "node_modules"), [".js", ".mjs", ".cjs", ".ts", ".md"], 60000, (p) => relative(ROOT, p));
/** 本仓库的 src/（中文注释的 TypeScript）。 */
const repoSrc = (): Doc[] => readDocs(join(ROOT, "src"), [".ts"], 120000, (p) => relative(ROOT, p));

function customCode(): Doc[] {
  const docs: Doc[] = [];
  for (const root of (process.env.PII_BENCH_DIRS ?? "").split(delimiter).filter(Boolean)) {
    const files: string[] = [];
    walk(root, files, new Set([".go", ".dart", ".ts", ".vue", ".rs", ".sql", ".yaml", ".yml", ".md", ".py", ".js"]), 60000);
    for (const p of files.slice(0, 60)) docs.push({ src: p.replace(HOME, "~"), text: readFileSync(p, "utf8") });
  }
  return docs;
}

function customSessions(): Doc[] {
  const docs: Doc[] = [];
  for (const dir of (process.env.PII_BENCH_SESSIONS ?? "").split(delimiter).filter(Boolean)) {
    const proj = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "session";
    const name = readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort().at(-1);
    if (!name) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.includes('"type":"message"')) continue;
      let e: { message?: { role?: string; content?: { type?: string; text?: string }[] } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      for (const c of e.message?.content ?? []) if (c.type === "text" && c.text && c.text.length > 40) docs.push({ src: `${proj}:${e.message?.role}`, text: c.text.slice(0, 20000) });
    }
  }
  return docs.slice(0, 400);
}

/** 速度用的四种内容：中文散文、英文散文（合成背景文本，各约 4 KB 一段）、代码（依赖源码）、JSON 工具输出（合成，约 4 KB 一段）。 */
function contentTypes(totalKB: number): Record<string, string[]> {
  const r = rng(SEED + 1);
  const n = Math.ceil(totalKB / 4);
  const code: string[] = [];
  let bytes = 0;
  for (const d of depCode().filter((x) => !x.src.endsWith(".md") && x.text.length < 20000)) {
    if (bytes >= totalKB * 1024) break;
    code.push(d.text);
    bytes += Buffer.byteLength(d.text);
  }
  return {
    "Chinese prose": Array.from({ length: n }, () => background(r, "zh", 4096)),
    "English prose": Array.from({ length: n }, () => background(r, "en", 4096)),
    "Code (dependency sources)": code,
    "JSON tool output": Array.from({ length: n }, () => jsonToolOutput(r, 4096)),
  };
}

// ---- 速度 -----------------------------------------------------------------------------------------

interface Loaded {
  guard: AstrGuard;
  loadMs: number;
  rssBeforeMB: number;
  rssLoadedMB: number;
  rssWarmMB: number;
  dir: string;
}

async function loadModel(threads: number): Promise<Loaded> {
  const dir = modelDir();
  const rssBefore = process.memoryUsage().rss;
  const { ms, value: guard } = await timed(() => AstrGuard.load(dir, threads, new Limiter(Math.max(1, Math.floor(os.availableParallelism() / threads)))));
  const rssLoaded = process.memoryUsage().rss;
  // 热身：几次完整窗口（分配推理用的缓冲区），再量一次常驻内存
  const warm = background(rng(SEED + 2), "en", 4096);
  for (let i = 0; i < 3; i++) await guard.find(warm);
  return { guard, loadMs: ms, rssBeforeMB: mb(rssBefore), rssLoadedMB: mb(rssLoaded), rssWarmMB: mb(process.memoryUsage().rss), dir };
}

interface TokModule {
  Tokenizer: { fromFile(p: string): { disableTruncation(): void; encode(t: string, pair: null, o: { addSpecialTokens: boolean }): Promise<{ getIds(): number[] }> } };
}

/** 恰好（或尽量接近）一个 510 token 窗口的文本，返回文本与实际 token 数。 */
async function windowText(dir: string, lang: Lang): Promise<{ text: string; tokens: number }> {
  // 与 src/guard.ts 一样按需动态加载原生依赖（CJS 包：命名导出在 default 上）
  const mod = (await import("@anush008/tokenizers")) as unknown as { default?: TokModule } & TokModule;
  const tok = (mod.default ?? mod).Tokenizer.fromFile(join(dir, "tokenizer.json"));
  tok.disableTruncation();
  const count = async (s: string): Promise<number> => (await tok.encode(s, null, { addSpecialTokens: false })).getIds().length;
  const base = background(rng(SEED + 3), lang, 8192);
  let lo = 0;
  let hi = base.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((await count(base.slice(0, mid))) <= 510) lo = mid;
    else hi = mid - 1;
  }
  const text = base.slice(0, lo);
  return { text, tokens: await count(text) };
}

interface WindowStat {
  tokens: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  runs: number;
}

async function windowLatency(l: Loaded): Promise<Record<string, WindowStat>> {
  const res: Record<string, WindowStat> = {};
  for (const lang of ["en", "zh"] as const) {
    const w = await windowText(l.dir, lang);
    for (let i = 0; i < 5; i++) await l.guard.find(w.text);
    const xs: number[] = [];
    for (let i = 0; i < 30; i++) xs.push((await timed(() => l.guard.find(w.text))).ms);
    res[lang === "en" ? "English prose" : "Chinese prose"] = { tokens: w.tokens, medianMs: median(xs), p95Ms: p95(xs), minMs: Math.min(...xs), runs: xs.length };
  }
  return res;
}

interface Throughput {
  kb: number;
  docs: number;
  inferMsPerKB: number;
  filterMsPerKB: number;
}

/** 各内容类型的 ms/KB：推理（逐段 find，段与段之间串行）与推理之外的过滤/替换（用缓存的识别结果重放）。 */
async function throughput(l: Loaded): Promise<Record<string, Throughput>> {
  const res: Record<string, Throughput> = {};
  for (const [name, docs] of Object.entries(contentTypes(64))) {
    const size = kb(docs);
    const inferMs: number[] = [];
    const filterMs: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const finds = new Map<string, RawFind[]>();
      const t0 = performance.now();
      for (const d of docs) finds.set(d, await l.guard.find(d));
      inferMs.push(performance.now() - t0);
      const masker = newMasker(replay(finds));
      filterMs.push((await timed(() => masker.maskTexts(docs.map((text) => ({ text, args: false }))))).ms);
    }
    res[name] = { kb: size, docs: docs.length, inferMsPerKB: median(inferMs) / size, filterMsPerKB: median(filterMs) / size };
  }
  return res;
}

/** 约 500 KB 的历史（四种内容轮流）与一段不在历史里的 ≈20 KB 工具输出。 */
function historyAndFresh(rep: number): { history: string[]; bytes: number; fresh: string } {
  const r = rng(SEED + 10);
  const code = depCode().filter((x) => !x.src.endsWith(".md") && x.text.length < 20000).map((x) => x.text);
  const history: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < 500 * 1024; i++) {
    const t = [() => background(r, "zh", 4096), () => background(r, "en", 4096), () => code[Math.floor(i / 4) % code.length]!, () => jsonToolOutput(r, 4096)][i % 4]!();
    history.push(t);
    bytes += Buffer.byteLength(t);
  }
  const fresh = jsonToolOutput(rng(SEED + 100 + rep), 20480);
  return { history, bytes, fresh };
}

const payload = (history: readonly string[], extra?: string): unknown => {
  const messages: unknown[] = history.map((text, i) =>
    i % 2 === 0
      ? { role: "user", content: [{ type: "text", text }] }
      : { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: [{ type: "text", text }] }] },
  );
  if (extra) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_new", content: [{ type: "text", text: extra }] }] });
  return { model: "claude", max_tokens: 1, system: "You are an assistant.", messages };
};

interface Prescan {
  historyKB: number;
  leaves: number;
  prescanMs: number[];
}

/** 预扫描 500 KB 历史（冷）。 */
async function prescan500(l: Loaded): Promise<Prescan & { masker: Masker; history: string[] }> {
  const prescanMs: number[] = [];
  let last!: { masker: Masker; history: string[]; bytes: number };
  for (let rep = 0; rep < REPS; rep++) {
    const { history, bytes } = historyAndFresh(rep);
    const masker = newMasker(l.guard);
    prescanMs.push((await timed(() => masker.prescan(history.map((text) => ({ text, args: false }))))).ms);
    last = { masker, history, bytes };
  }
  return { historyKB: last.bytes / 1024, leaves: last.history.length, prescanMs, masker: last.masker, history: last.history };
}

async function egress(l: Loaded, p: Prescan & { masker: Masker; history: string[] }): Promise<Record<string, unknown>> {
  const run = (extra?: string): Promise<{ ms: number }> => timed(() => maskPayload("anthropic-messages", payload(p.history, extra), { maskTexts: (items) => p.masker.maskTexts(items) }));
  const first = (await run()).ms;
  const steady: number[] = [];
  for (let i = 0; i < 5; i++) steady.push((await run()).ms);
  // 新增 ≈20 KB 工具输出（历史已缓存，新文本要推理）；每次换一段新文本
  const freshMs: number[] = [];
  let freshKB = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const { fresh } = historyAndFresh(rep);
    freshKB = kb([fresh]);
    freshMs.push((await run(fresh)).ms);
  }
  return { firstAfterPrescanMs: first, steadyMs: steady, freshKB, freshMs };
}

/** 已知值补遮：1 MB 文本 × 1000 个已知值，每次用新的 Map（含建索引）；再测索引已缓存的一次。 */
function knownBench(): Record<string, unknown> {
  const L = "abcdefghijklmnopqrstuvwxyz";
  const M = `${L}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
  const first: number[] = [];
  const cached: number[] = [];
  let hits = 0;
  let planted = 0;
  let size = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const r = rng(SEED + 20 + rep);
    const ch = (a: string, n: number): string => Array.from({ length: n }, () => a[Math.floor(r() * a.length)]).join("");
    const known = new Map<string, Kind>();
    for (let i = 0; known.size < 1000; i++) {
      if (i % 4 === 0) known.set(`${ch(M, 14)}9Q`, "SECRET");
      else if (i % 4 === 1) known.set(`${ch(L, 6)}.${ch(L, 4)}@${ch(L, 7)}.com`, "EMAIL");
      else if (i % 4 === 2) known.set(`1${3 + Math.floor(r() * 6)}${ch("0123456789", 9)}`, "PHONE");
      else known.set(`${ch(L, 5)} ${ch(L, 7)}`, "PERSON");
    }
    const values = [...known.keys()];
    const parts: string[] = [];
    planted = 0;
    let len = 0;
    for (let w = 0; len < 1 << 20; w++) {
      let word: string;
      if (w % 40 === 39) {
        word = values[Math.floor(r() * values.length)]!;
        planted++;
      } else word = ch(L, 2 + Math.floor(r() * 7));
      parts.push(word, w % 12 === 11 ? "\n" : " ");
      len += word.length + 1;
    }
    const text = parts.join("");
    size = text.length;
    const t0 = performance.now();
    const sp: Span[] = knownSpans(text, known);
    first.push(performance.now() - t0);
    hits = sp.length;
    const t1 = performance.now();
    knownSpans(text, known);
    cached.push(performance.now() - t1);
  }
  return { chars: size, values: 1000, planted, hits, firstMs: first, cachedMs: cached };
}

// ---- 效果 -----------------------------------------------------------------------------------------

const KINDS: readonly Kind[] = ["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT", "SECRET"];

async function inferAll(guard: AstrGuard, texts: readonly string[]): Promise<Map<string, RawFind[]>> {
  const m = new Map<string, RawFind[]>();
  for (const t of texts) if (!m.has(t)) m.set(t, await guard.find(t));
  return m;
}

const spansOf = (text: string, finds: RawFind[]): Span[] => modelSpans(text, finds, { args: false, threshold: cfg.threshold, kinds: cfg.kinds, allow: cfg.allow });

async function syntheticEffect(guard: AstrGuard): Promise<Record<string, unknown>> {
  const docs = annotated(SEED, PER_KIND);
  const neg = ["zh", "en"].flatMap((lang) => Array.from({ length: 100 }, (_, i) => background(rng(SEED + 50 + i + (lang === "zh" ? 0 : 1000)), lang as Lang, 1024)));
  const finds = await inferAll(guard, [...docs.map((d) => d.text), ...neg]);

  type Cell = { n: number; full: number; any: number; wrongKind: number };
  const cell = (): Cell => ({ n: 0, full: 0, any: 0, wrongKind: 0 });
  const byKind = new Map<string, Cell>();
  const byStyle = new Map<string, Cell>();
  const add = (m: Map<string, Cell>, k: string, full: boolean, any: boolean, wrong: boolean): void => {
    const c = m.get(k) ?? cell();
    c.n++;
    if (full) c.full++;
    if (any) c.any++;
    if (wrong) c.wrongKind++;
    m.set(k, c);
  };
  const extra: Record<string, number> = {};
  let extraTotal = 0;
  let planted = 0;
  for (const d of docs) {
    const sp = spansOf(d.text, finds.get(d.text)!);
    const used = new Set<Span>();
    for (const p of d.planted) {
      planted++;
      const over = sp.filter((s) => s.start < p.end && s.end > p.start);
      over.forEach((s) => used.add(s));
      const full = over.some((s) => s.kind === p.kind && s.start <= p.start && s.end >= p.end);
      const any = over.length > 0;
      const wrong = any && !over.some((s) => s.kind === p.kind);
      for (const k of [`${p.lang}/${p.kind}`, `all/${p.kind}`, `${p.lang}/all`, "all/all"]) add(byKind, k, full, any, wrong);
      for (const k of [p.style, `${p.kind}/${p.style}`]) add(byStyle, k, full, any, wrong);
    }
    for (const s of sp) if (!used.has(s)) (extra[s.kind] = (extra[s.kind] ?? 0) + 1), extraTotal++;
  }
  const negSpans: Record<string, number> = {};
  let negTotal = 0;
  for (const t of neg) for (const s of spansOf(t, finds.get(t)!)) (negSpans[s.kind] = (negSpans[s.kind] ?? 0) + 1), negTotal++;

  // 整条管线（含已知值补遮）：被替换的区间总数，与种下的值数对照
  const masker = newMasker(replay(finds));
  const replaced: Record<string, number> = {};
  await masker.maskTexts(docs.map((d) => ({ text: d.text, args: false })), { onTag: (k) => void (replaced[k] = (replaced[k] ?? 0) + 1) });

  const docKB = kb(docs.map((d) => d.text));
  const negKB = kb(neg);
  heading(`Synthetic annotated corpus (seed ${SEED}; ${docs.length} paragraphs, ${docKB.toFixed(0)} KB, ${planted} planted values; threshold ${cfg.threshold})`);
  const rowOf = (key: string, name: string): (string | number)[] => {
    const c = byKind.get(key)!;
    return [name, c.n, pct(c.full, c.n), pct(c.any, c.n), c.wrongKind];
  };
  console.log(
    table(
      ["Kind", "Planted", "Fully masked (right kind)", "Touched (any span)", "Wrong kind only"],
      [...KINDS.map((k) => rowOf(`all/${k}`, k)), rowOf("zh/all", "— Chinese paragraphs"), rowOf("en/all", "— English paragraphs"), rowOf("all/all", "**All**")],
    ),
  );
  console.log("\nPer kind × language, fully masked:\n");
  console.log(table(["Kind", "Chinese", "English"], KINDS.map((k) => [k, `${pct(byKind.get(`zh/${k}`)!.full, byKind.get(`zh/${k}`)!.n)} (${byKind.get(`zh/${k}`)!.full}/${byKind.get(`zh/${k}`)!.n})`, `${pct(byKind.get(`en/${k}`)!.full, byKind.get(`en/${k}`)!.n)} (${byKind.get(`en/${k}`)!.full}/${byKind.get(`en/${k}`)!.n})`])));
  console.log('\nBy kind × context style (sentence = natural sentence, field = `Key: value`, json = `"key": "value"`, env = `KEY=value`), fully masked:\n');
  const styles = ["sentence", "field", "json", "env"];
  const styleCell = (k: string): string => {
    const c = byStyle.get(k);
    return c ? `${pct(c.full, c.n)} (${c.full}/${c.n})` : "—";
  };
  console.log(table(["Kind", ...styles], [...KINDS.map((k) => [k, ...styles.map((st) => styleCell(`${k}/${st}`))]), ["**All**", ...styles.map(styleCell)]]));
  console.log(`\nSpans outside planted values inside the annotated paragraphs: ${extraTotal} (${Object.entries(extra).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}).`);
  console.log(`Entity-free control text (200 paragraphs, ${negKB.toFixed(0)} KB, same background sentences): ${negTotal} masked spans (${Object.entries(negSpans).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}).`);
  console.log(`Whole pipeline (incl. known-value pass) replaced ${Object.values(replaced).reduce((a, b) => a + b, 0)} spans in the annotated paragraphs (${Object.entries(replaced).map(([k, v]) => `${k} ${v}`).join(", ")}).`);

  // 漏遮的值：模型有没有给出过重叠的原始结果（label、分数）——区分“模型没找到”“分数低于阈值”“过阈值但被过滤/修边丢掉”
  const missed = docs.flatMap((d) => {
    const sp = spansOf(d.text, finds.get(d.text)!);
    return d.planted
      .filter((p) => !sp.some((s) => s.kind === p.kind && s.start <= p.start && s.end >= p.end))
      .map((p) => ({
        lang: p.lang,
        kind: p.kind,
        style: p.style,
        value: p.value,
        covered: sp.filter((s) => s.start < p.end && s.end > p.start).map((s) => ({ kind: s.kind, text: d.text.slice(s.start, s.end) })),
        raw: finds.get(d.text)!.filter((x) => x.start < p.end && x.end > p.start).map((x) => ({ label: x.label, score: Number(x.score.toFixed(3)), text: d.text.slice(x.start, x.end) })),
      }));
  });
  const diag = { noRawSpan: 0, belowThreshold: 0, droppedOrTrimmed: 0 };
  for (const m of missed) {
    if (m.raw.length === 0) diag.noRawSpan++;
    else if (m.raw.every((x) => x.score < cfg.threshold)) diag.belowThreshold++;
    else diag.droppedOrTrimmed++;
  }
  console.log(`\nOf the ${missed.length} values not fully masked: ${diag.noRawSpan} had no model span at all (score ≥ 0.5), ${diag.belowThreshold} only spans below the ${cfg.threshold} threshold, ${diag.droppedOrTrimmed} had a span at or above the threshold that the filters dropped or trimmed.`);
  return {
    seed: SEED,
    perKind: PER_KIND,
    paragraphs: docs.length,
    kb: docKB,
    planted,
    byKind: Object.fromEntries(byKind),
    byStyle: Object.fromEntries(byStyle),
    spansOutsidePlanted: extra,
    control: { paragraphs: neg.length, kb: negKB, maskedSpans: negSpans },
    pipelineReplaced: replaced,
    missedDiagnosis: diag,
    missed,
  };
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.:/-][A-Za-z0-9_$]+)*$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** 代码里 import 的模块名与清单里的包名（检查它们没被当成人名/密钥遮掉）。 */
function moduleNames(docs: readonly Doc[]): Set<string> {
  const names = new Set<string>();
  const res = [
    /\bimport\s+(?:[^'"\n]*?\sfrom\s+)?["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm,
    /^\s*"([\w./-]+)"\s*$/gm,
    /^\s*([\w./-]+)\s+v\d[\w.+-]*\s*$/gm,
    /"([@\w./-]+)"\s*:\s*"[~^]?\d/g,
  ];
  for (const d of docs) for (const re of res) for (const m of d.text.matchAll(re)) names.add(m[1]!);
  return names;
}

/** 值的形状：大写 A、小写 a、数字 9、汉字 汉，其余原样（不含真实内容）。 */
const shape = (s: string): string =>
  [...s].map((c) => (/[A-Z]/.test(c) ? "A" : /[a-z]/.test(c) ? "a" : /[0-9]/.test(c) ? "9" : /[\u4e00-\u9fff]/.test(c) ? "汉" : c)).join("").replace(/(.)\1{3,}/g, (x, c) => `${c}{${x.length}}`);

const lineOf = (text: string, at: number): number => {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < at; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/** 在一组文档上跑整条管线，报告被遮的区间：类别、行号、形状（公开语料另给原值，便于人工判断）。 */
async function codeEffect(name: string, docs: Doc[], guard: AstrGuard, publicCorpus: boolean): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const finds = await inferAll(guard, docs.map((d) => d.text));
  const inferMs = performance.now() - t0;
  const modules = moduleNames(docs);
  // 口径一：模型区间经阈值与误报过滤后的数量（不含已知值补遮）
  const modelKinds: Record<string, number> = {};
  for (const d of docs) for (const sp of spansOf(d.text, finds.get(d.text)!)) modelKinds[sp.kind] = (modelKinds[sp.kind] ?? 0) + 1;
  const modelTotal = Object.values(modelKinds).reduce((x, y) => x + y, 0);

  // 口径二：整条管线（含已知值补遮）实际替换的区间。从输出里的占位符还原出每处替换的原值与位置，
  // 并用“把占位符换回原值后与原文逐字相同”校验对齐；对不上的文档单独计数。
  const masker = newMasker(replay(finds));
  const outs = await masker.maskTexts(docs.map((d) => ({ text: d.text, args: false })));
  const byKind: Record<string, number> = {};
  const hits: { src: string; line: number; kind: Kind; shape: string; value?: string }[] = [];
  let snake = 0;
  let moduleHit = 0;
  let identLike = 0;
  let unaligned = 0;
  docs.forEach((d, i) => {
    const o = outs[i]!;
    let at = 0;
    let rebuilt = "";
    const found: { start: number; kind: Kind; v: string }[] = [];
    let last = 0;
    for (const m of o.matchAll(PH_RE)) {
      const v = masker.ph.lookup(m[0]);
      if (v === undefined) continue;
      rebuilt += o.slice(last, m.index);
      at += m.index! - last;
      found.push({ start: at, kind: m[1] as Kind, v });
      rebuilt += v;
      at += v.length;
      last = m.index! + m[0].length;
    }
    rebuilt += o.slice(last);
    if (rebuilt !== d.text) {
      unaligned++;
      return;
    }
    for (const h of found) {
      byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
      if (SNAKE.test(h.v)) snake++;
      if (modules.has(h.v)) moduleHit++;
      if (IDENT.test(h.v)) identLike++;
      hits.push({ src: d.src, line: lineOf(d.text, h.start), kind: h.kind, shape: shape(h.v).slice(0, 32), ...(publicCorpus ? { value: h.v.slice(0, 80) } : {}) });
    }
  });
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const size = kb(docs.map((d) => d.text));
  heading(`${name}: ${docs.length} files, ${size.toFixed(0)} KB`);
  console.log(
    table(
      ["Model spans after filters", "Whole pipeline replaced (incl. known-value pass)", "Pipeline, by kind", "snake_case values replaced", "import/package names replaced", "Identifier-shaped values replaced", "Inference ms/KB"],
      [[modelTotal, total, Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(", ") || "none", snake, moduleHit, identLike, f(inferMs / size)]],
    ),
  );
  console.log(`\n(${modules.size} import/package names collected from the same files for the check; model spans by kind: ${Object.entries(modelKinds).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ${unaligned} files could not be aligned and are left out of the pipeline detail.)`);
  if (publicCorpus && hits.length > 0) {
    console.log("\nSpans replaced by the whole pipeline (public sources; value truncated to 80 chars):\n");
    console.log(table(["File:line", "Kind", "Value"], hits.map((h) => [`${h.src}:${h.line}`, h.kind, `\`${(h.value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "⏎")}\``])));
  } else if (hits.length > 0) {
    const shapes = new Map<string, number>();
    for (const h of hits) shapes.set(`${h.kind} ${h.shape}`, (shapes.get(`${h.kind} ${h.shape}`) ?? 0) + 1);
    console.log(`\nShapes (private corpus, no values): ${[...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, n]) => `${s}×${n}`).join("  ")}`);
  }
  return { files: docs.length, kb: size, inferMsPerKB: inferMs / size, modelSpansByKind: modelKinds, modelSpansTotal: modelTotal, pipelineReplacedByKind: byKind, pipelineReplacedTotal: total, unalignedFiles: unaligned, snakeCaseMasked: snake, moduleNamesMasked: moduleHit, identifierShaped: identLike, moduleNamesCollected: modules.size, hits };
}

// ---- 主流程 ---------------------------------------------------------------------------------------

function envInfo(l: Loaded): Record<string, unknown> {
  const ortVer = JSON.parse(readFileSync(join(ROOT, "node_modules/onnxruntime-node/package.json"), "utf8")).version as string;
  return {
    date: new Date().toISOString(),
    runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cores: os.availableParallelism(),
    memGB: Math.round(os.totalmem() / 2 ** 30),
    onnxruntimeNode: ortVer,
    threads: THREADS,
    concurrentWindows: Math.max(1, Math.floor(os.availableParallelism() / THREADS)),
    model: l.dir.replace(HOME, "~"),
    reps: REPS,
    loadAvgAtStart: os.loadavg().map((x) => Number(x.toFixed(1))).join(" / "),
  };
}

function printLoad(l: Loaded): void {
  heading(`Model load and memory (${THREADS} threads)`);
  console.log(
    table(
      ["Metric", "Value"],
      [
        ["Model load (import onnxruntime + tokenizer + create session; files in OS page cache)", `${f(l.loadMs, 0)} ms`],
        ["RSS before load", `${f(l.rssBeforeMB, 0)} MB`],
        ["RSS after load", `${f(l.rssLoadedMB, 0)} MB (+${f(l.rssLoadedMB - l.rssBeforeMB, 0)} MB)`],
        ["RSS after 3 warm-up inferences", `${f(l.rssWarmMB, 0)} MB (+${f(l.rssWarmMB - l.rssBeforeMB, 0)} MB)`],
      ],
    ),
  );
}

function printWindow(w: Record<string, WindowStat>): void {
  heading("Single 510-token window (`find()` on a text of one window; 5 warm-up + 30 runs)");
  console.log(table(["Text", "Tokens", "Median", "p95", "Min"], Object.entries(w).map(([k, v]) => [k, v.tokens, `${f(v.medianMs)} ms`, `${f(v.p95Ms)} ms`, `${f(v.minMs)} ms`])));
}

function printThroughput(t: Record<string, Throughput>): void {
  heading(`Throughput by content type (~64 KB each, median of ${REPS} runs, one document at a time)`);
  console.log(table(["Content", "Docs", "KB", "Inference ms/KB", "Filter + replace ms/KB"], Object.entries(t).map(([k, v]) => [k, v.docs, f(v.kb), f(v.inferMsPerKB), f(v.filterMsPerKB, 3)])));
}

async function speed(l: Loaded): Promise<void> {
  out.window = await windowLatency(l);
  printWindow(out.window as Record<string, WindowStat>);
  out.throughput = await throughput(l);
  printThroughput(out.throughput as Record<string, Throughput>);

  const p = await prescan500(l);
  const eg = await egress(l, p);
  out.history = { historyKB: p.historyKB, leaves: p.leaves, prescanMs: p.prescanMs, ...eg };
  heading("Egress masking (history of mixed content: Chinese/English prose, code, JSON tool output)");
  console.log(
    table(
      ["Scenario", "Time"],
      [
        [`Prescan a ${f(p.historyKB, 0)} KB / ${p.leaves}-leaf history, nothing cached (median of ${REPS}; ${p.prescanMs.map((x) => f(x / 1000, 1) + " s").join(" / ")})`, `${f(median(p.prescanMs) / 1000, 1)} s`],
        ["Egress of that history after prescan, first request (spans filtered + replaced)", `${f(eg.firstAfterPrescanMs as number, 1)} ms`],
        [`Egress, repeated requests (median of 5; ${(eg.steadyMs as number[]).map((x) => f(x, 2)).join(" / ")} ms)`, `${f(median(eg.steadyMs as number[]), 2)} ms`],
        [`Egress with a new ${f(eg.freshKB as number, 1)} KB tool output on top of the cached history (median of ${REPS}; ${(eg.freshMs as number[]).map((x) => f(x, 0)).join(" / ")} ms)`, `${f(median(eg.freshMs as number[]), 0)} ms`],
      ],
    ),
  );
  const k = knownBench();
  out.known = k;
  heading("Known-value pass (no model)");
  console.log(
    table(
      ["Scenario", "Time"],
      [
        [`${(k.chars as number / 1048576).toFixed(2)} Mi chars × ${k.values} known values, ${k.hits}/${k.planted} hits, new Map each time incl. index build (median of ${REPS}; ${(k.firstMs as number[]).map((x) => f(x, 1)).join(" / ")} ms)`, `${f(median(k.firstMs as number[]))} ms`],
        [`Same, index cached (median of ${REPS}; ${(k.cachedMs as number[]).map((x) => f(x, 1)).join(" / ")} ms)`, `${f(median(k.cachedMs as number[]))} ms`],
      ],
    ),
  );
}

async function effect(l: Loaded): Promise<void> {
  out.synthetic = await syntheticEffect(l.guard);
  out.dependencies = await codeEffect("Public code corpus A: dependency sources in node_modules (.js/.mjs/.cjs/.ts/.md)", depCode(), l.guard, true);
  out.repoSrc = await codeEffect("Public code corpus B: this repository's src/ (Chinese-commented TypeScript)", repoSrc(), l.guard, true);
  const own = customCode();
  if (own.length > 0) out.customCode = await codeEffect("Your code corpus (PII_BENCH_DIRS)", own, l.guard, false);
  const sess = customSessions();
  if (sess.length > 0) out.customSessions = await codeEffect("Your omp sessions (PII_BENCH_SESSIONS)", sess, l.guard, false);
}

/** 子进程：一个线程数下的冷加载、窗口、各类型 ms/KB、预扫描 500 KB，结果以一行 JSON 输出。 */
async function child(): Promise<void> {
  const log = console.log;
  console.log = () => {}; // 子进程只输出最后一行 JSON
  const l = await loadModel(THREADS);
  const w = await windowLatency(l);
  const t = await throughput(l);
  const p = await prescan500(l);
  log(JSON.stringify({ threads: THREADS, loadMs: l.loadMs, rssLoadedMB: l.rssLoadedMB, rssWarmMB: l.rssWarmMB, rssBeforeMB: l.rssBeforeMB, window: w, throughput: t, historyKB: p.historyKB, prescanMs: p.prescanMs, concurrentWindows: Math.max(1, Math.floor(os.availableParallelism() / THREADS)), loadAvgAtEnd: os.loadavg()[0] }));
}

interface ChildResult {
  threads: number;
  loadMs: number;
  rssBeforeMB: number;
  rssLoadedMB: number;
  rssWarmMB: number;
  window: Record<string, WindowStat>;
  throughput: Record<string, Throughput>;
  historyKB: number;
  prescanMs: number[];
  concurrentWindows: number;
  loadAvgAtEnd: number;
}

async function sweep(): Promise<void> {
  const rows: ChildResult[] = [];
  for (const n of [1, 2, 4, 8]) {
    console.error(`threads=${n} …`);
    const r = Bun.spawnSync([process.execPath, "run", process.argv[1]!, "child"], { env: { ...process.env, THREADS: String(n) }, stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`子进程失败（threads=${n}）：exit ${r.exitCode}`);
    rows.push(JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!));
  }
  out.sweep = rows;
  const types = Object.keys(rows[0].throughput);
  heading(`Thread sweep (each row is a fresh process; concurrent windows = cores / threads; median of ${REPS} runs where repeated)`);
  console.log(
    table(
      ["Threads", "Concurrent windows", "Load", "RSS after warm-up", "510-token window, English (median)", "510-token window, Chinese (median)", ...types.map((t) => `${t} ms/KB`), `Prescan ${f(rows[0].historyKB, 0)} KB history`, "Load avg (1 min) at end"],
      rows.map((r) => [r.threads, r.concurrentWindows, `${f(r.loadMs, 0)} ms`, `${f(r.rssWarmMB, 0)} MB`, `${f(r.window["English prose"].medianMs)} ms`, `${f(r.window["Chinese prose"].medianMs)} ms`, ...types.map((t) => f(r.throughput[t].inferMsPerKB)), `${f(median(r.prescanMs) / 1000, 1)} s`, f(r.loadAvgAtEnd)]),
    ),
  );
}

async function main(): Promise<void> {
  if (mode === "child") return child();
  if (mode === "sweep") {
    await sweep();
  } else {
    if (!["all", "speed", "effect"].includes(mode)) throw new Error(`未知模式 ${mode}（all|speed|effect|sweep）`);
    const l = await loadModel(THREADS);
    out.env = envInfo(l);
    out.load = { loadMs: l.loadMs, rssBeforeMB: l.rssBeforeMB, rssLoadedMB: l.rssLoadedMB, rssWarmMB: l.rssWarmMB };
    heading("Environment");
    console.log(table(["Item", "Value"], Object.entries(out.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])));
    printLoad(l);
    if (mode === "all" || mode === "speed") await speed(l);
    if (mode === "all" || mode === "effect") await effect(l);
  }
  if (process.env.PII_BENCH_JSON) {
    writeFileSync(process.env.PII_BENCH_JSON, JSON.stringify(out, null, 2));
    console.error(`JSON → ${process.env.PII_BENCH_JSON}`);
  }
}

await main();
