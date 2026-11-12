// 批量恢复基准：模拟 Tern 一次恢复很多 omp 会话——N 个子进程同时启动，各自加载真实模型，预扫描各自不同的合成历史（每份约 300 KB）。
//
//   bun scripts/bench.ts restore        （没有 Bun 时：BUN_BE_BUN=1 <omp 二进制> run scripts/bench.ts restore）
//
// 每一轮都是全新的 N 个进程；用同一个临时数据目录依次跑两轮：第一轮缓存是空的（冷），第二轮同一批历史再扫一遍（热）。
// 报告：墙钟时间（启动到最后一个进程退出）、所有子进程的 CPU 时间之和（user+system）、期间的峰值忙核数与峰值 1 分钟负载、
// 送进模型的文本数（find 调用次数，一段文本按 510 token 窗口切成若干次推理）。临时数据目录与里面的缓存、槽位用完即删，不碰真实的 ~/.omp。
//
// 子进程里的接线与 src/index.ts 的 runtime() 一致：Limiter(总槽位数, 跨进程槽位)、Masker 的持久缓存、模型在会话启动时就开始加载
// （index.ts 在 session_start 里预热模型）。跑基线：用 `git worktree add /tmp/pii-baseline bd45b51`、`ln -s <本仓库>/node_modules`
// 或复制 node_modules 之后，PII_BENCH_SRC=/tmp/pii-baseline/src PII_BENCH_RESTORE_ROUNDS=1 bun scripts/bench.ts restore；
// 目录里没有 cache.ts / slots.ts 就按旧版接线（进程内 Limiter、无持久缓存、无跨进程限流）。
//
// 环境变量：
//   PII_BENCH_RESTORE_PROCS   并发进程数，默认 8
//   PII_BENCH_RESTORE_KB      每份历史的大小（KB），默认 300
//   PII_BENCH_RESTORE_ROUNDS  轮数，默认 2（冷、热）；基线没有缓存，一轮即可
//   PII_BENCH_SRC             被测的 src 目录，默认本仓库的 src
//   THREADS                   ORT 线程数，默认 4
//   PII_BENCH_SEED            合成语料种子，默认 20260101
//   PII_BENCH_JSON            把结果写成 JSON 文件
//   PII_GUARD_MODEL_DIR       模型目录（缺省依次试 PII_GUARD_DIR/model、magpie 缓存）

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { restoreHistory } from "./bench-corpus.ts";

const ROOT = join(import.meta.dir, "..");
const SRC = process.env.PII_BENCH_SRC ?? join(ROOT, "src");
const THREADS = Number(process.env.THREADS ?? 4);
const SEED = Number(process.env.PII_BENCH_SEED ?? 20260101);
const hasCache = existsSync(join(SRC, "cache.ts"));
const hasSlots = existsSync(join(SRC, "slots.ts"));

function modelDir(): string {
  const root = process.env.PII_GUARD_DIR || join(os.homedir(), ".omp", "agent", "pii-guard");
  const cands = [process.env.PII_GUARD_MODEL_DIR, join(root, "model"), join(os.homedir(), ".cache/magpie/astrlink-guard/7216b6a3b897")].filter((x): x is string => !!x);
  const dir = cands.find((d) => existsSync(join(d, "model_int8.onnx")));
  if (!dir) throw new Error(`找不到模型：先在 omp 里运行 /pii setup，或用 PII_GUARD_MODEL_DIR 指定（试过：${cands.join("、")}）`);
  return dir;
}

// ---- 子进程 ---------------------------------------------------------------------------------------

async function child(): Promise<void> {
  const t0 = performance.now();
  const worker = Number(process.env.PII_BENCH_WORKER ?? 0);
  const kb = Number(process.env.PII_BENCH_RESTORE_KB ?? 300);
  const root = process.env.PII_GUARD_DIR!;
  const mods = { guard: await import(join(SRC, "guard.ts")), mask: await import(join(SRC, "mask.ts")), ph: await import(join(SRC, "placeholder.ts")), config: await import(join(SRC, "config.ts")) };
  const cfg = mods.config.defaultConfig();
  const cores = os.availableParallelism();
  const total = Math.max(1, Math.floor(cores / THREADS));
  const background = Math.max(1, Math.floor(Math.floor(cores / 2) / THREADS));
  const key = Buffer.alloc(32, 9);

  const slots = hasSlots ? (await import(join(SRC, "slots.ts"))).openGlobalSlots({ dir: join(root, "slots"), total, background }) : undefined;
  const cache = hasCache
    ? (await import(join(SRC, "cache.ts"))).openFindCache({ file: join(root, "cache", "finds.sqlite"), key: () => key, revision: mods.guard.MODEL_REVISION, debug: (m: string) => console.error(m) })
    : undefined;
  const limiter = new mods.guard.Limiter(total, slots);

  // 与 index.ts 一样，会话启动就开始加载模型（不等预扫描）
  let loadMs = 0;
  const guardP = (async () => {
    const t = performance.now();
    const g = await mods.guard.AstrGuard.load(modelDir(), THREADS, limiter);
    loadMs = performance.now() - t;
    return g;
  })();
  guardP.catch(() => {});
  let finds = 0;
  const recognizer = { find: async (text: string, bg?: boolean) => (finds++, (await guardP).find(text, bg)) };
  const masker = new mods.mask.Masker(async () => recognizer, new mods.ph.Placeholders(() => key), () => cfg, () => cache);

  const history = restoreHistory(SEED + 1000 + worker, kb * 1024);
  const s = performance.now();
  await masker.prescan(history.map((text) => ({ text, args: false })));
  const scanMs = performance.now() - s;
  await guardP.catch(() => {});
  cache?.close();
  const cpu = process.cpuUsage();
  console.log(JSON.stringify({ worker, leaves: history.length, loadMs, scanMs, finds, wallMs: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000 }));
}

// ---- 父进程 ---------------------------------------------------------------------------------------

interface Child { worker: number; leaves: number; loadMs: number; scanMs: number; finds: number; wallMs: number; cpuMs: number }
interface Round { name: string; wallMs: number; cpuSumMs: number; peakBusyCores: number; peakLoad1: number; peakSlots: number | undefined; loadStart: number; loadEnd: number; texts: number; modelLoads: number; children: Child[] }

const f = (x: number, d = 1): string => x.toFixed(d);
const table = (h: string[], rows: (string | number)[][]): string => [h, h.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
}

async function round(name: string, dir: string, model: string, procs: number): Promise<Round> {
  const cores = os.availableParallelism();
  let peakBusy = 0;
  let peakLoad = os.loadavg()[0]!;
  let peakSlots = hasSlots ? 0 : undefined;
  const loadStart = os.loadavg()[0]!;
  let prev = cpuTimes();
  const t0 = performance.now();
  const sampler = setInterval(() => {
    const cur = cpuTimes();
    const dt = cur.total - prev.total;
    if (dt > 0) peakBusy = Math.max(peakBusy, ((cur.busy - prev.busy) / dt) * cores);
    prev = cur;
    peakLoad = Math.max(peakLoad, os.loadavg()[0]!);
  }, 1000);
  const slotSampler = hasSlots
    ? setInterval(() => {
        try {
          peakSlots = Math.max(peakSlots!, readdirSync(join(dir, "slots")).filter((n) => n.startsWith("slot-")).length);
        } catch {}
      }, 50)
    : undefined;
  const runs = Array.from({ length: procs }, async (_, worker) => {
    const p = Bun.spawn([process.execPath, "run", join(ROOT, "scripts/bench.ts"), "restore-child"], {
      env: { ...process.env, PII_GUARD_DIR: dir, PII_GUARD_MODEL_DIR: model, PII_BENCH_WORKER: String(worker), THREADS: String(THREADS) },
      stdout: "pipe",
      stderr: "inherit",
    });
    const text = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) throw new Error(`子进程 ${worker} 退出码 ${code}`);
    return JSON.parse(text.trim().split("\n").at(-1)!) as Child;
  });
  let children: Child[];
  try {
    children = await Promise.all(runs);
  } finally {
    clearInterval(sampler);
    if (slotSampler) clearInterval(slotSampler);
  }
  const wallMs = performance.now() - t0;
  return {
    name,
    wallMs,
    cpuSumMs: children.reduce((a, c) => a + c.cpuMs, 0),
    peakBusyCores: peakBusy,
    peakLoad1: peakLoad,
    peakSlots,
    loadStart,
    loadEnd: os.loadavg()[0]!,
    texts: children.reduce((a, c) => a + c.finds, 0),
    modelLoads: children.filter((c) => c.loadMs > 0).length,
    children,
  };
}

export async function run(mode: string): Promise<void> {
  if (mode === "restore-child") return child();
  const procs = Number(process.env.PII_BENCH_RESTORE_PROCS ?? 8);
  const kb = Number(process.env.PII_BENCH_RESTORE_KB ?? 300);
  const rounds = Number(process.env.PII_BENCH_RESTORE_ROUNDS ?? 2);
  const cores = os.availableParallelism();
  const model = modelDir(); // 先按真实数据目录解析；子进程的 PII_GUARD_DIR 是临时目录，在那里找不到模型
  const dir = mkdtempSync(join(os.tmpdir(), "pii-bench-restore-"));
  const results: Round[] = [];
  console.error(`restore：${procs} 个进程 × ${kb} KB，${rounds} 轮，THREADS=${THREADS}，源码 ${SRC}${hasCache ? "" : "（旧版接线，无缓存）"}；开始负载 ${os.loadavg().map((x) => x.toFixed(1)).join(" ")}`);
  try {
    for (let i = 0; i < rounds; i++) {
      const name = hasCache ? (i === 0 ? "cold cache" : "warm cache") : `start ${i + 1} (no cache)`;
      console.error(`${name} …`);
      results.push(await round(name, dir, model, procs));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n### Batch restore: ${procs} processes × ~${kb} KB distinct history each (THREADS=${THREADS}, ${cores} cores, ${hasSlots ? `cross-process slots total ${Math.max(1, Math.floor(cores / THREADS))} / background ${Math.max(1, Math.floor(Math.floor(cores / 2) / THREADS))}` : "in-process limiter only"})\n`);
  console.log(
    table(
      ["Round", "Wall clock", "CPU time, sum of all processes", "Peak busy cores (1 s samples, whole machine)", "Peak load avg (1 min)", "Peak slots held", "Texts sent to the model", "Processes that loaded the model", "Load avg at start → end"],
      results.map((r) => [r.name, `${f(r.wallMs / 1000, 1)} s`, `${f(r.cpuSumMs / 1000, 1)} s`, r.wallMs < 1000 ? "n/a (run < 1 s)" : f(r.peakBusyCores), f(r.peakLoad1), r.peakSlots ?? "n/a", r.texts, `${r.modelLoads}/${procs}`, `${f(r.loadStart)} → ${f(r.loadEnd)}`]),
    ),
  );
  console.log(`\nPer process (median / max): ${results.map((r) => {
    const s = [...r.children].sort((a, b) => a.wallMs - b.wallMs);
    return `${r.name}: wall ${f(s[s.length >> 1]!.wallMs / 1000, 1)} / ${f(s.at(-1)!.wallMs / 1000, 1)} s`;
  }).join("; ")}`);
  if (process.env.PII_BENCH_JSON) {
    writeFileSync(process.env.PII_BENCH_JSON, JSON.stringify({ procs, kb, threads: THREADS, cores, src: SRC, rounds: results }, null, 2));
    console.error(`JSON → ${process.env.PII_BENCH_JSON}`);
  }
}
