// A4/A5 的实测脚本（不是单测）：在 POC 同一语料上跑整条管线，输出各类别遮挡数、耗时。
// 输出只给形状与计数，不打印真实值或其前后文。
//   BUN_BE_BUN=1 <omp 18.18.1> scripts/bench.ts [corpus|perf|all]
// 模型目录：PII_GUARD_MODEL_DIR，默认 magpie 的缓存。语料取样规则同 /tmp/astrlink-poc/bench.mjs。
// readdir 的顺序随运行时不同（Node 与 Bun 不同），所以 PII_BENCH_FILES 可以指向一个文件清单（每行一个路径）
// 固定取样；不给时按名字排序遍历，结果可复现。
// 语料目录由环境变量指定（路径之间用 ":" 分隔，Windows 用 ";"），脚本里没有任何默认语料：
//   PII_BENCH_DIRS      代码语料的根目录（递归取样源码与文档）；与 PII_BENCH_FILES 二选一（corpus、perf 都要）
//   PII_BENCH_SESSIONS  omp 会话目录（各含 .jsonl，取每个目录里名字排序最后一个）；不给则跳过“omp 会话文本”语料

import { readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import * as os from "node:os";
import { defaultConfig } from "../src/config.ts";
import { modelSpans } from "../src/filters.ts";
import { AstrGuard, Limiter } from "../src/guard.ts";
import { Masker } from "../src/mask.ts";
import { maskPayload } from "../src/payload.ts";
import { Placeholders } from "../src/placeholder.ts";
import type { Kind, RawFind } from "../src/types.ts";

const HOME = os.homedir();
const MODEL = process.env.PII_GUARD_MODEL_DIR || join(HOME, ".cache/magpie/astrlink-guard/7216b6a3b897");
const THREADS = Number(process.env.THREADS ?? 4);
const mode = process.argv[2] ?? "all";

/** 读环境变量里的路径列表。 */
const pathsFromEnv = (name: string): string[] => (process.env[name] ?? "").split(delimiter).filter(Boolean);

interface Doc {
  src: string;
  text: string;
}

function walk(dir: string, out: string[], exts: Set<string>, limit: number): void {
  for (const name of readdirSync(dir).sort()) {
    if (out.length >= limit) return;
    if (/^(node_modules|\.git|build|dist|\.dart_tool|target|vendor|\.pnpm-store|\.idea|webs|ios|android|macos|windows|linux|web)$/.test(name)) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p, out, exts, limit);
    else if (exts.has(extname(name)) && st.size < 60000 && st.size > 300) out.push(p);
  }
}

function codeCorpus(): Doc[] {
  if (process.env.PII_BENCH_FILES) {
    const files = readFileSync(process.env.PII_BENCH_FILES, "utf8").split("\n").filter(Boolean);
    return files.map((f) => ({ src: f.replace(HOME, "~"), text: readFileSync(f, "utf8") }));
  }
  const exts = new Set([".go", ".dart", ".ts", ".vue", ".rs", ".sql", ".yaml", ".yml", ".md", ".py"]);
  const dirs = pathsFromEnv("PII_BENCH_DIRS");
  if (dirs.length === 0) throw new Error("没有语料：请设置 PII_BENCH_DIRS（代码目录，多个用 " + delimiter + " 分隔）或 PII_BENCH_FILES（文件清单）");
  const files: string[] = [];
  for (const r of dirs) {
    walk(r, files, exts, files.length + 60);
  }
  return files.map((f) => ({ src: f.replace(HOME, "~"), text: readFileSync(f, "utf8") }));
}

function sessionCorpus(): Doc[] {
  const out: Doc[] = [];
  for (const dir of pathsFromEnv("PII_BENCH_SESSIONS")) {
    const proj = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "session";
    const f = readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort().at(-1)!;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.includes('"type":"message"')) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = e.message;
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const c of msg.content) if (c.type === "text" && c.text?.length > 40) out.push({ src: `${proj}:${msg.role}`, text: c.text.slice(0, 20000) });
    }
  }
  return out.slice(0, 400);
}

const kb = (docs: Doc[]): number => docs.reduce((n, d) => n + Buffer.byteLength(d.text), 0) / 1024;
const ms = (t0: number): string => (performance.now() - t0).toFixed(0);

/** 值的“形状”：大写 A、小写 a、数字 9、汉字 汉，其余原样（不含真实内容）。 */
const shape = (s: string): string =>
  [...s].map((c) => (/[A-Z]/.test(c) ? "A" : /[a-z]/.test(c) ? "a" : /[0-9]/.test(c) ? "9" : /[\u4e00-\u9fff]/.test(c) ? "汉" : c)).join("").replace(/(.)\1{3,}/g, (x, c) => `${c}{${x.length}}`);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.:/-][A-Za-z0-9_$]+)*$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** 代码里 import 的模块名与清单里的包名（用来检查它们没被遮）。 */
function moduleNames(docs: Doc[]): Set<string> {
  const names = new Set<string>();
  const res = [
    /\bimport\s+(?:[^'"\n]*?\sfrom\s+)?["']([^"']+)["']/g, // ts/js/go/dart
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm, // python
    /^\s*"([\w./-]+)"\s*$/gm, // go import 块
    /^\s*([\w./-]+)\s+v\d[\w.+-]*\s*$/gm, // go.mod
    /"([@\w./-]+)"\s*:\s*"[~^]?\d/g, // package.json 依赖
    /^\s{2}([\w-]+):\s*[\^<>=\d]/gm, // pubspec
  ];
  for (const d of docs) for (const re of res) for (const m of d.text.matchAll(re)) names.add(m[1]!);
  return names;
}

const LABEL_KIND: Record<string, Kind | undefined> = {
  private_person: "PERSON", private_address: "ADDRESS", phone: "PHONE", email: "EMAIL", account: "ACCOUNT", payment_card: "ACCOUNT", common_secret: "SECRET",
};

async function corpusRun(name: string, docs: Doc[], guard: AstrGuard, code: boolean): Promise<void> {
  const cfg = defaultConfig();
  const t0 = performance.now();
  const finds: RawFind[][] = [];
  for (const d of docs) finds.push(await guard.find(d.text));
  const inferMs = performance.now() - t0;

  // (a) POC 同口径：模型原始结果，分数 ≥ 0.8，按标签
  const raw: Record<string, number> = {};
  for (const f of finds) for (const x of f) if (x.score >= 0.8) raw[x.label] = (raw[x.label] ?? 0) + 1;
  // (b) 经 modelSpans（阈值、修边、误报过滤）后各类别
  const afterFilters: Record<string, number> = {};
  const spans = docs.map((d, i) => modelSpans(d.text, finds[i]!, { args: false, threshold: cfg.threshold, kinds: cfg.kinds, allow: cfg.allow }));
  spans.forEach((sp) => sp.forEach((s) => (afterFilters[s.kind] = (afterFilters[s.kind] ?? 0) + 1)));
  // (c) 整条管线（含已知值补遮）：每个被替换的区间
  const rec = { find: async (text: string) => finds[docs.findIndex((d) => d.text === text)]! };
  const ph = new Placeholders(() => Buffer.alloc(32, 9));
  const masker = new Masker(async () => rec, ph, () => cfg);
  const replaced: Record<string, number> = {};
  const t1 = performance.now();
  const outs = await masker.maskTexts(docs.map((d) => ({ text: d.text, args: false })), {
    onTag: (kind) => {
      replaced[kind] = (replaced[kind] ?? 0) + 1;
    },
  });
  const pipeMs = performance.now() - t1;

  const total = docs.length;
  console.log(`\n== ${name}: ${total} 段, ${kb(docs).toFixed(0)} KB；推理 ${inferMs.toFixed(0)} ms（${(inferMs / kb(docs)).toFixed(1)} ms/KB，${THREADS} 线程）；其余管线 ${pipeMs.toFixed(0)} ms`);
  const fmt = (o: Record<string, number>): string =>
    Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("，") || "无";
  console.log(`  (a) 模型原始（≥0.8，含 url/ip/date，POC 同口径）：${fmt(raw)}`);
  console.log(`  (b) 过阈值与误报过滤后的区间：${fmt(afterFilters)}`);
  console.log(`  (c) 整条管线实际替换的区间（含已知值补遮）：${fmt(replaced)}`);

  // 形状（按类别汇总，每类最多 8 种形状，无上下文）
  const shapes: Record<string, Map<string, number>> = {};
  const identLike: Record<string, number> = {};
  const violations = { snake: 0, moduleName: 0 };
  const modules = code ? moduleNames(docs) : new Set<string>();
  docs.forEach((d, i) => {
    const text = d.text;
    for (const s of spans[i]!) {
      const v = text.slice(s.start, s.end);
      const m = (shapes[s.kind] ??= new Map());
      const sh = shape(v).slice(0, 32);
      m.set(sh, (m.get(sh) ?? 0) + 1);
      if (IDENT.test(v)) identLike[s.kind] = (identLike[s.kind] ?? 0) + 1;
      if (code) {
        if (SNAKE.test(v)) violations.snake++;
        if (modules.has(v)) violations.moduleName++;
      }
    }
  });
  for (const [k, m] of Object.entries(shapes)) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `${s}×${n}`).join("  ");
    console.log(`  ${k.padEnd(8)} 像代码标识符 ${identLike[k] ?? 0} / ${[...m.values()].reduce((a, b) => a + b, 0)}；形状：${top}`);
  }
  if (code) console.log(`  代码语料检查：被遮的 snake_case 词 ${violations.snake}；被遮的 import 模块名/包名 ${violations.moduleName}（应为 0）；已收集模块/包名 ${modules.size} 个`);
  // 实际被替换文本里残留的已知占位符数量（只是汇总）
  console.log(`  输出中占位符个数：${outs.reduce((n, o) => n + (o.match(/\{\{[A-Z]+_[a-z2-7]{8}\}\}/g)?.length ?? 0), 0)}；不同的值 ${ph.byPh.size}`);
}

async function perfRun(guard: AstrGuard): Promise<void> {
  const docs = codeCorpus();
  const cfg = defaultConfig();
  const ph = new Placeholders(() => Buffer.alloc(32, 9));
  const masker = new Masker(async () => guard, ph, () => cfg);

  // 500 KB 历史：每段一个叶子（交替 user / tool_result），留一个不在历史里的 ≈20 KB 文本作新工具输出
  const history: Doc[] = [];
  let bytes = 0;
  const rest: Doc[] = [];
  for (const d of docs) {
    if (bytes < 500 * 1024) {
      history.push(d);
      bytes += Buffer.byteLength(d.text);
    } else rest.push(d);
  }
  // 新增工具输出：不在历史里的文件拼到 20 KB（20480 字节）
  let freshText = "";
  for (const d of rest) {
    freshText += d.text + "\n";
    if (Buffer.byteLength(freshText) >= 20480) break;
  }
  while (Buffer.byteLength(freshText) > 20480) freshText = freshText.slice(0, -64);
  const fresh = { src: "fresh", text: freshText };
  const messages = (extra?: string) => {
    const m: any[] = history.map((d, i) =>
      i % 2 === 0
        ? { role: "user", content: [{ type: "text", text: d.text }] }
        : { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: [{ type: "text", text: d.text }] }] },
    );
    if (extra) m.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_new", content: [{ type: "text", text: extra }] }] });
    return { model: "claude", max_tokens: 1, system: "你是助手", messages: m };
  };

  console.log(`\n== A5 性能（${THREADS} 线程；历史 ${(bytes / 1024).toFixed(0)} KB / ${history.length} 个叶子；新增工具输出 ${(Buffer.byteLength(fresh.text) / 1024).toFixed(1)} KB）`);
  const t0 = performance.now();
  await masker.prescan(history.map((d) => ({ text: d.text, args: false })));
  console.log(`  预扫描 500 KB 历史：${ms(t0)} ms`);

  // 指标 1：已预扫描的 500 KB 历史，出口遮挡耗时
  let t = performance.now();
  await maskPayload("anthropic-messages", messages(), { maskTexts: (items) => masker.maskTexts(items) });
  console.log(`  指标1 出口遮挡（预扫描后首次，要做 span 过滤与补遮）：${ms(t)} ms`);
  const again: number[] = [];
  for (let i = 0; i < 5; i++) {
    t = performance.now();
    await maskPayload("anthropic-messages", messages(), { maskTexts: (items) => masker.maskTexts(items) });
    again.push(performance.now() - t);
  }
  console.log(`  指标1 出口遮挡（之后每次，全命中缓存；构造 payload 与遍历一并计入）：${again.map((x) => x.toFixed(0)).join("/")} ms`);

  // 指标 2：新增 20 KB 工具输出，出口耗时（历史已缓存，新文本要推理）
  t = performance.now();
  await maskPayload("anthropic-messages", messages(fresh.text), { maskTexts: (items) => masker.maskTexts(items) });
  console.log(`  指标2 新增 20 KB 工具输出的出口遮挡（含推理）：${ms(t)} ms`);
}

const guard = await AstrGuard.load(MODEL, THREADS, new Limiter(Math.max(1, Math.floor(os.availableParallelism() / THREADS))));
console.log(`threads=${THREADS} 模型 ${MODEL.replace(HOME, "~")}`);
if (mode === "corpus" || mode === "all") {
  await corpusRun("代码语料", codeCorpus(), guard, true);
  if (pathsFromEnv("PII_BENCH_SESSIONS").length > 0) await corpusRun("omp 会话文本", sessionCorpus(), guard, false);
  else console.log("\n（未设置 PII_BENCH_SESSIONS，跳过 omp 会话文本语料）");
}
if (mode === "perf" || mode === "all") await perfRun(guard);
