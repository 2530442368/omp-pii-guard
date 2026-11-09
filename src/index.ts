// omp 扩展入口：本地模型（AstrLink Guard）脱敏，可还原。
//   - before_provider_request：主路径，遮挡请求体；失败 return {}（请求不发出），不放行原文。
//   - 网络层（transport.ts）：兜底，覆盖不经 bpr 的直连请求。
//   - tool_call / assistant_message / 助手文本渲染器：把占位符还原成原值。
//   - 映射经 pi.appendEntry 持久化，session_start/branch/tree/switch 时重建。
// 子代理会话与主会话同进程，模型、缓存、占位符表、网络层包装用 globalThis 单例，只装一次。

import * as os from "node:os";
import { ALL_KINDS, envDisabled, envNoRestore, loadConfig, paths, type Config, type Paths } from "./config.ts";
import { AstrGuard, Limiter } from "./guard.ts";
import { LocalLiterals } from "./local.ts";
import { MaskTimeout, Masker } from "./mask.ts";
import { detectFormat, formatForApi, maskPayload, type TextItem, type TextMasker } from "./payload.ts";
import { PH_RE, Placeholders, loadKey, restorePolicy } from "./placeholder.ts";
import { defaultCacheDir, setupModel } from "./setup.ts";
import { addLlmOrigin, installTransport, transportProblems } from "./transport.ts";
import type { Kind } from "./types.ts";

/** bpr 处理器 30 s 超时后 omp 会发出原文，所以自己 25 s 截止。 */
export const BPR_BUDGET_MS = 25_000;
/** 网络层没有 30 s 限制，但不能无限等。 */
export const NET_BUDGET_MS = 180_000;
const MAP_ENTRY = "pii-guard.map";
const VERIFIED_VERSION = /^18\.18\./;
/** 已确认是 omp 占位符的 $$…$$ 的个数上限（超过淘汰最旧的）。 */
const MAX_CONFIRMED = 20_000;

type Level = "info" | "warning" | "error";

/** 全进程单例。 */
interface Runtime {
  paths: Paths;
  config: Config;
  limiter: Limiter;
  ph: Placeholders;
  masker: Masker;
  guardP: Promise<AstrGuard> | undefined;
  guard: AstrGuard | undefined;
  guardErr: string | undefined;
  /** /pii on|off（进程内，所有会话）。 */
  userOff: boolean;
  noRestore: boolean;
  /**
   * 已确认是 omp 生成的占位符的 $$…$$（出口处理器见到的：严格格式、本地会话与系统提示里都没有字面出现）。
   * 网络层只保护这个集合里的 $$…$$，其余照常识别。
   */
  confirmed: Set<string>;
  /** 出口处理器的内部截止（毫秒）；测试里可调小。 */
  bprBudgetMs: number;
  /** 出口失败（返回 {}）后，omp 可能还会发出一个空壳请求，网络层会拒发它；它不是新请求，不再计数。记下还没消耗的个数。 */
  shellsPending: number;
  /** /pii setup 正在进行的任务（进行中再次执行不会并发下载）。 */
  setupP: Promise<void> | undefined;
  notifier: ((msg: string, level: Level) => void) | undefined;
  lastNotice: Map<string, number>;
  versionChecked: boolean;
  stats: { bprRequests: number; bprChanged: number; bprFailed: number; bprFallbackToNet: number; netRequests: number; netRefused: number; netChanged: number; failures: number };
}

const RT = Symbol.for("omp-pii-guard.runtime");
const G = globalThis as unknown as Record<symbol, Runtime | undefined>;

function runtime(): Runtime {
  const hit = G[RT];
  if (hit) return hit;
  const p = paths();
  const config = loadConfig(p.configFile);
  const cores = os.availableParallelism();
  const ph = new Placeholders(() => loadKey(p.keyFile));
  const rt: Runtime = {
    paths: p,
    config,
    limiter: new Limiter(Math.max(1, Math.floor(cores / config.threads))),
    ph,
    masker: undefined as unknown as Masker,
    guardP: undefined,
    guard: undefined,
    guardErr: undefined,
    userOff: false,
    noRestore: envNoRestore(),
    confirmed: new Set(),
    bprBudgetMs: BPR_BUDGET_MS,
    notifier: undefined,
    lastNotice: new Map(),
    versionChecked: false,
    stats: { bprRequests: 0, bprChanged: 0, bprFailed: 0, bprFallbackToNet: 0, netRequests: 0, netRefused: 0, netChanged: 0, failures: 0 },
    shellsPending: 0,
    setupP: undefined,
  };
  rt.masker = new Masker(() => recognizer(rt), ph, () => rt.config);
  rt.masker.configChanged(); // 阈值、类别、允许词先生效（映射恢复、补遮都按它过滤）
  G[RT] = rt;
  return rt;
}

/** 测试用：取得 / 清掉进程单例。 */
export const testHooks = {
  runtime,
  reset(): void {
    G[RT] = undefined;
  },
};

const isOn = (rt: Runtime): boolean => !envDisabled() && !rt.userOff;

function confirm(rt: Runtime, ph: string): void {
  rt.confirmed.delete(ph);
  rt.confirmed.add(ph);
  if (rt.confirmed.size > MAX_CONFIRMED) rt.confirmed.delete(rt.confirmed.values().next().value as string);
}

function recognizer(rt: Runtime): Promise<AstrGuard> {
  rt.guardP ??= AstrGuard.load(rt.paths.modelDir, rt.config.threads, rt.limiter).then(
    (g) => {
      rt.guard = g;
      rt.guardErr = undefined;
      return g;
    },
    (e: unknown) => {
      rt.guardP = undefined; // 下次请求重试（用户可能刚装好模型）
      rt.guard = undefined;
      rt.guardErr = `模型加载失败：${String((e as Error)?.message ?? e)}`;
      throw new Error(rt.guardErr);
    },
  );
  return rt.guardP;
}

const OFF_HINT = "临时关闭：/pii off，或设置环境变量 OMP_PII_GUARD=off 后重启";

/** /pii setup 的后台任务：准备模型文件，成功后重置模型错误状态并立即加载（无需重启）。结果用通知告知。 */
async function runSetup(rt: Runtime): Promise<void> {
  const start = Date.now();
  try {
    const r = await setupModel({ dir: rt.paths.modelDir, cacheDir: defaultCacheDir() });
    if (!rt.guard) {
      rt.guardErr = undefined;
      rt.guardP = undefined;
    }
    await recognizer(rt);
    const how = (h: string): number => r.files.filter((x) => x.how === h).length;
    const parts = [how("已下载") > 0 ? `下载 ${how("已下载")} 个` : "", how("已复制") > 0 ? `复制 ${how("已复制")} 个` : "", how("已就绪") > 0 ? `已有 ${how("已就绪")} 个` : ""].filter(Boolean);
    notify(rt, `模型就绪（${parts.join("，")}，校验通过，用时 ${((Date.now() - start) / 1000).toFixed(1)} 秒），无需重启`, "info");
  } catch (e) {
    notify(rt, `模型准备失败：${String((e as Error)?.message ?? e)}。可再执行 /pii setup 重试`, "error");
  }
}

function notify(rt: Runtime, msg: string, level: Level): void {
  const now = Date.now();
  const last = rt.lastNotice.get(msg);
  if (last !== undefined && now - last < 5000) return;
  rt.lastNotice.set(msg, now);
  if (rt.lastNotice.size > 50) rt.lastNotice.clear();
  try {
    if (rt.notifier) {
      rt.notifier(msg, level);
      return;
    }
  } catch {}
  console.error(`[pii-guard] ${msg}`);
}

function fail(rt: Runtime, where: string, err: unknown): void {
  rt.stats.failures++;
  const reason = String((err as Error)?.message ?? err);
  notify(rt, `${where}遮挡失败，请求未发出：${reason}。${OFF_HINT}`, "error");
}

function ompVersion(pi: any): string | undefined {
  const v = pi?.pi?.VERSION ?? pi?.version ?? process.env.PI_CODING_AGENT_VERSION;
  if (typeof v === "string") return v;
  return /versions[\\/](\d+\.\d+\.\d+)/.exec(process.execPath)?.[1];
}

// ---- 会话里的文本 -----------------------------------------------------------------------------

/** 工具参数：对象里的字符串叶子。 */
function deepStrings(v: unknown, out: TextItem[], args: boolean): void {
  if (typeof v === "string") out.push({ text: v, args });
  else if (Array.isArray(v)) for (const x of v) deepStrings(x, out, args);
  else if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) for (const x of Object.values(v)) deepStrings(x, out, args);
}

function contentTexts(content: unknown, out: TextItem[]): void {
  if (typeof content === "string") {
    out.push({ text: content, args: false });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b === null || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") out.push({ text: b.text, args: false });
    else if (b.type === "toolCall") deepStrings(b.arguments, out, true);
  }
}

/** 会话分支里要预扫描的文本。 */
function branchTexts(entries: readonly any[]): TextItem[] {
  const out: TextItem[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "message") contentTexts(e.message?.content, out);
    else if (e.type === "custom_message") contentTexts(e.content, out);
    else if ((e.type === "compaction" || e.type === "branch_summary") && typeof e.summary === "string") out.push({ text: e.summary, args: false });
  }
  return out;
}

// ---- 扩展 ------------------------------------------------------------------------------------

export default function piiGuard(pi: any): void {
  const rt = runtime();
  pi.setLabel?.("PII Guard");

  // 这个会话的状态（工厂对每个会话重新运行）
  /** 已写进这个会话的占位符 → 已写的识别分数（分数提高了要追加更新）。 */
  const persisted = new Map<string, number>();
  const used = new Map<Kind, Set<string>>();
  const queue: TextItem[] = [];
  let scanning = false;
  const local = new LocalLiterals();

  /**
   * 出口：严格格式的 $$…$$ 在本地会话/系统提示里字面出现过 → 不是 omp 的占位符，不保护；没出现过 → 是 omp 刚生成的，
   * 保护并记入进程内“已确认”集合（网络层据此保护）。读不到本地内容时一个都不保护（宁可多遮）。
   * 本地扫描不完整（触顶、跳过了读不了的内容、系统提示读失败）时，没扫到不等于本地没有：本次不新增确认，
   * 只有已确认集合里的才保护。
   */
  const dollarCheck = (ctx: any): ((ph: string) => boolean) => {
    let literals: Set<string>;
    let complete: boolean;
    try {
      let sys: string | undefined;
      let sysOk = true;
      try {
        const s = ctx.getSystemPrompt?.();
        sys = typeof s === "string" ? s : undefined;
      } catch {
        sysOk = false;
      }
      const got = local.collect(ctx.sessionManager.getBranch(), sys);
      literals = got.literals;
      complete = got.complete && sysOk;
    } catch {
      return () => false;
    }
    return (ph) => {
      if (literals.has(ph)) {
        rt.confirmed.delete(ph); // 本地有字面出现：之前确认过的也撤销
        return false;
      }
      if (complete) {
        confirm(rt, ph);
        return true;
      }
      return rt.confirmed.has(ph);
    };
  };

  /** 请求里出现的占位符：计数，并把还没写进这个会话的映射写进去。 */
  const noteUsed = (texts: readonly string[]): void => {
    const fresh: { ph: string; value: string; s: number }[] = [];
    const before = new Map<string, number | undefined>();
    for (const t of texts) {
      if (!t.includes("{{")) continue;
      for (const m of t.matchAll(PH_RE)) {
        const ph = m[0];
        const kind = m[1] as Kind;
        const value = rt.ph.lookup(ph);
        if (value === undefined) continue; // 映射里没有：请求里字面写的、长得像占位符的串，不计
        const set = used.get(kind) ?? new Set<string>();
        used.set(kind, set.add(ph));
        const s = rt.ph.scoreOf(ph);
        const had = persisted.get(ph);
        if (had === undefined || s > had) {
          before.set(ph, had);
          persisted.set(ph, s);
          fresh.push({ ph, value, s });
        }
      }
    }
    if (fresh.length === 0) return;
    try {
      pi.appendEntry(MAP_ENTRY, { e: fresh });
    } catch (e) {
      for (const f of fresh) {
        const had = before.get(f.ph);
        if (had === undefined) persisted.delete(f.ph);
        else persisted.set(f.ph, had);
      }
      notify(rt, `占位符映射写入会话失败（--resume 后这些占位符可能无法还原）：${String((e as Error)?.message ?? e)}`, "warning");
    }
  };

  const loadBranch = (ctx: any): any[] => {
    let entries: any[] = [];
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return [];
    }
    persisted.clear();
    for (const e of entries) {
      if (e?.type === "custom" && e.customType === MAP_ENTRY && Array.isArray(e.data?.e)) {
        rt.ph.load(e.data.e, rt.config.kinds, rt.config.allow);
        for (const x of e.data.e) {
          if (typeof x?.ph !== "string") continue;
          const s = typeof x.s === "number" && x.s >= 0 && x.s <= 1 ? x.s : 1;
          persisted.set(x.ph, Math.max(persisted.get(x.ph) ?? -1, s));
        }
      }
    }
    return entries;
  };

  /** 后台预扫描：用 ctx.setTimeout 分批做，异常只吞掉（模型问题会在请求出口明确报错）。 */
  const scan = (ctx: any, items: readonly TextItem[]): void => {
    if (!isOn(rt) || items.length === 0) return;
    queue.push(...items);
    if (scanning) return;
    scanning = true;
    ctx.setTimeout(async () => {
      try {
        while (queue.length > 0) {
          if (!isOn(rt)) {
            queue.length = 0;
            break;
          }
          await rt.masker.prescan(queue.splice(0, 16));
        }
      } catch (e) {
        queue.length = 0;
        pi.logger?.debug?.(`pii-guard 预扫描失败：${String((e as Error)?.message ?? e)}`);
      } finally {
        scanning = false;
      }
    }, 0);
  };

  /** 提示一律走主会话的界面（子代理会话没有自己的界面）。 */
  const bindNotifier = (ctx: any): void => {
    if (rt.notifier && ctx.agent?.kind === "sub") return;
    rt.notifier = (msg, level) => {
      if (ctx.hasUI) ctx.ui.notify(msg, level);
      else console.error(`[pii-guard] ${msg}`);
    };
  };

  /**
   * 已知的 LLM 服务（网络层在这些 origin 的推理端点上认不出的体不发出）：内置默认 + omp 模型注册表里的 baseUrl
   * （ctx.models.list()，已认证的可用模型）+ bpr 里见到的 ctx.model.baseUrl + 环境变量里的提供方基址覆盖
   * （`*_BASE_URL`，如 ANTHROPIC_BASE_URL：omp 的 SDK 按它改发请求的地址，ctx.model.baseUrl 不反映）。
   * 按 origin（协议 + 主机 + 有效端口）登记。
   */
  const learnOrigins = (ctx: any): void => {
    const add = (baseUrl: unknown): void => {
      if (typeof baseUrl === "string" && baseUrl) addLlmOrigin(baseUrl);
    };
    add(ctx.model?.baseUrl);
    try {
      for (const m of ctx.models?.list?.() ?? []) add(m?.baseUrl);
    } catch {}
    for (const [k, v] of Object.entries(process.env)) if (k.endsWith("_BASE_URL")) add(v);
  };

  const sessionKickoff = (ctx: any, full: boolean): void => {
    bindNotifier(ctx);
    learnOrigins(ctx);
    if (full) {
      // 重读 config.json（改了 allow/kinds/阈值，开一个新会话就生效）
      rt.config = loadConfig(rt.paths.configFile);
      rt.masker.configChanged();
    }
    const entries = loadBranch(ctx);
    if (!isOn(rt)) return;
    if (full) {
      for (const w of rt.config.warnings) notify(rt, w, "warning");
      // 预热模型：加载失败尽早提示
      ctx.setTimeout(async () => {
        try {
          await recognizer(rt);
        } catch (e) {
          notify(rt, `${String((e as Error)?.message ?? e)}。模型就绪前所有发往模型服务的请求都会被阻止。${OFF_HINT}`, "error");
        }
      }, 0);
      const problems = transportProblems();
      if (problems.length > 0) notify(rt, `网络层包装不在位（${problems.join(", ")}）：直连请求可能得不到遮挡`, "warning");
      if (!rt.versionChecked) {
        rt.versionChecked = true;
        const v = ompVersion(pi);
        if (!v || !VERIFIED_VERSION.test(v)) notify(rt, `网络层遮挡未在此 omp 版本验证（${v ?? "版本未知"}，已验证 18.18.x）`, "warning");
      }
    }
    scan(ctx, branchTexts(entries));
  };

  // ---- /pii ----
  pi.registerCommand("pii", {
    description: "PII Guard 状态；/pii setup 准备模型；/pii on|off 开关",
    handler: async (args: string, ctx: any) => {
      const a = String(args ?? "").trim().toLowerCase();
      if (a === "on" || a === "off") {
        if (envDisabled()) {
          ctx.ui.notify("已被环境变量 OMP_PII_GUARD=off 全局关闭；去掉它并重启 omp 才能开启", "warning");
          return;
        }
        rt.userOff = a === "off";
        ctx.ui.notify(rt.userOff ? "pii-guard 已关闭（本进程所有会话；请求原样发出，还原仍然有效）" : "pii-guard 已开启", rt.userOff ? "warning" : "info");
        return;
      }
      if (a === "setup") {
        if (envDisabled()) {
          ctx.ui.notify("已被环境变量 OMP_PII_GUARD=off 全局关闭，无需准备模型；去掉它并重启 omp 后再执行", "warning");
          return;
        }
        if (rt.setupP) {
          ctx.ui.notify("模型准备已在进行中，完成后会有通知", "info");
          return;
        }
        bindNotifier(ctx);
        ctx.ui.notify(`开始准备模型（约 37 MB，目标 ${rt.paths.modelDir}）：已有的跳过，其次复制本机缓存，否则从 Hugging Face 下载并校验。完成后会有通知`, "info");
        rt.setupP = runSetup(rt).finally(() => {
          rt.setupP = undefined;
        });
        return;
      }
      if (a !== "" && a !== "status") {
        ctx.ui.notify("用法：/pii（状态）、/pii setup（准备模型）、/pii on、/pii off", "warning");
        return;
      }
      const st = status(rt, used);
      ctx.ui.notify(st.text, st.level);
    },
  });

  if (envDisabled()) {
    pi.on("session_start", async (_e: unknown, ctx: any) => {
      bindNotifier(ctx);
      notify(rt, "pii-guard 已被 OMP_PII_GUARD=off 全局关闭，不遮挡任何请求", "warning");
    });
    return;
  }

  // 网络层（全进程只装一次；处理函数读全局 deps）
  installTransport({
    enabled: () => isOn(rt),
    maskBody: async (format, body) => {
      const deadline = Date.now() + NET_BUDGET_MS;
      // 网络层只保护出口处理器已确认过的 $$…$$
      const n = await maskPayload(format, body, { maskTexts: (items) => rt.masker.maskTexts(items, { deadline, isDollar: (ph) => rt.confirmed.has(ph) }) });
      rt.stats.netRequests++; // 只计遮挡成功的；失败与拒发的由 fail 回调计入 netRefused，每个请求恰好计一次
      if (n > 0) rt.stats.netChanged++;
      return n;
    },
    fail: (where, err) => {
      // 网络层每拒发一个请求恰好调用一次：认不出的体、不支持的编码、遮挡失败都在内
      if (rt.shellsPending > 0) rt.shellsPending--;
      else rt.stats.netRefused++;
      fail(rt, `网络层（${where}）`, err);
    },
  });

  pi.on("session_start", async (_e: unknown, ctx: any) => sessionKickoff(ctx, true));
  pi.on("session_switch", async (_e: unknown, ctx: any) => sessionKickoff(ctx, false));
  pi.on("session_branch", async (_e: unknown, ctx: any) => sessionKickoff(ctx, false));
  pi.on("session_tree", async (_e: unknown, ctx: any) => sessionKickoff(ctx, false));

  // 压缩可能由网络层遮挡（不经 bpr，没有 noteUsed）：压缩保存后，把压缩结果与分支里出现的已知占位符补写进这个会话，
  // 否则 --resume 后摘要里的占位符无法还原。按事件所属的会话执行，不依赖“最后初始化的会话”。
  pi.on("session_compact", async (event: any, ctx: any) => {
    try {
      const items: TextItem[] = [];
      deepStrings(event?.compactionEntry, items, false);
      try {
        items.push(...branchTexts(ctx.sessionManager.getBranch()));
      } catch {}
      noteUsed(items.map((i) => i.text));
    } catch (e) {
      notify(rt, `压缩后写入占位符映射失败：${String((e as Error)?.message ?? e)}`, "warning");
    }
    return undefined;
  });

  // ---- 出口遮挡（主路径）----
  pi.on("before_provider_request", async (event: any, ctx: any) => {
    if (!isOn(rt)) return undefined;
    bindNotifier(ctx);
    learnOrigins(ctx);
    rt.stats.bprRequests++;
    const api: string | undefined = ctx.model?.api;
    try {
      const format = formatForApi(api);
      if (!format) throw new Error(`不支持的请求格式 api="${api ?? "未知"}"（支持 anthropic-messages、openai-responses、openai-codex-responses、openai-completions）`);
      const deadline = Date.now() + rt.bprBudgetMs;
      const isDollar = dollarCheck(ctx);
      const masker: TextMasker = {
        maskTexts: async (items) => {
          const out = await rt.masker.maskTexts(items, { deadline, isDollar });
          noteUsed(out);
          return out;
        },
      };
      const n = await maskPayload(format, event.payload, masker);
      if (n > 0) rt.stats.bprChanged++;
      return undefined; // 就地改写
    } catch (e) {
      if (e instanceof MaskTimeout && transportProblems().length === 0 && detectFormat(undefined, event.payload) !== undefined) {
        // 超时：模型扫描在后台继续；网络层（无 30 s 限制）会在发出前遮挡这个请求
        rt.stats.bprFallbackToNet++;
        return undefined;
      }
      rt.stats.bprFailed++;
      rt.shellsPending++;
      fail(rt, "出口（before_provider_request）", e);
      return {};
    }
  });

  // ---- 还原 ----
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (rt.noRestore) return undefined;
    try {
      const policy = restorePolicy(String(event.toolName ?? ""), event.input, rt.config);
      if (policy === "all") return undefined;
      const { value, changed } = rt.ph.restoreDeep(event.input, policy);
      if (!changed) return undefined;
      const items: TextItem[] = [];
      deepStrings(value, items, true);
      scan(ctx, items);
      return { input: value };
    } catch (e) {
      return { block: true, reason: `pii-guard 还原工具参数失败：${String((e as Error)?.message ?? e)}` };
    }
  });

  pi.on("assistant_message", async (event: any, ctx: any) => {
    try {
      const blocks: any[] = event.message?.content ?? [];
      let changed = false;
      const items: TextItem[] = [];
      const next = blocks.map((b) => {
        if (b?.type !== "text" || typeof b.text !== "string") return b;
        const text = rt.noRestore ? b.text : rt.ph.restoreText(b.text);
        items.push({ text, args: false });
        if (text === b.text) return b;
        changed = true;
        return { ...b, text };
      });
      scan(ctx, items);
      return changed ? { content: next } : undefined;
    } catch (e) {
      notify(rt, `还原助手消息失败：${String((e as Error)?.message ?? e)}`, "warning");
      return undefined;
    }
  });

  pi.registerAssistantTextRenderer?.((r: { text: string; streaming: boolean }) => {
    if (rt.noRestore) return undefined;
    const t = rt.ph.restoreText(r.text);
    const shown = r.streaming ? hidePartialPlaceholder(t) : t;
    return shown === r.text ? undefined : shown;
  });

  // ---- 后台预扫描 ----
  pi.on("input", async (event: any, ctx: any) => {
    if (typeof event?.text === "string") scan(ctx, [{ text: event.text, args: false }]);
    return undefined;
  });
  pi.on("tool_result", async (event: any, ctx: any) => {
    const items: TextItem[] = [];
    contentTexts(event?.content, items);
    scan(ctx, items);
    return undefined;
  });
}

/** 流式输出时行尾还没闭合的 `{{…`：先隐藏，等闭合后再显示（以免闪出半截占位符）。 */
export function hidePartialPlaceholder(text: string): string {
  return text.replace(/\{\{[A-Z]*(?:_[a-z2-7]*)?\}?$|\{$/, "");
}

const KIND_ZH: Record<Kind, string> = { PERSON: "人名", ADDRESS: "地址", PHONE: "手机", EMAIL: "邮箱", ACCOUNT: "账号", SECRET: "密码" };
const DEFAULT_THRESHOLD = 0.8;

/**
 * 已检查的请求数（不重复）。网络层在位时，所有真正发出或被拒发的推理请求都会过网络层：遮挡成功的计入 netRequests，
 * 被拒发的（认不出的体、不支持的编码、遮挡失败）计入 netRefused，每个请求恰好一次（见 maskBody 与 fail 回调）。
 * 主会话请求先过出口处理器（bprRequests），所以与网络层重叠；出口失败的请求不会到网络层（bprFailed 补回），
 * 但 omp 可能还会发出一个空壳请求被网络层拒发，它由 shellsPending 抵消，不重复计数。
 *   distinct = max(netRequests + netRefused + bprFailed, bprRequests)
 * 网络层没有直连请求时两边相等，有直连（标题、压缩等）时网络层一侧更大；出口放行但请求没发出去时 bprRequests 更大；
 * 网络层不在位时退化为 bprRequests。
 * 取舍：出口放行却没发出去（如用户取消），同时又有直连请求时会少计；出口失败后空壳没有被拒发（没发出）时，
 * 抵消额度会留着、吞掉之后的一次拒发——都是少计，不会多计。
 */
export function checkedRequests(s: Runtime["stats"]): number {
  return Math.max(s.netRequests + s.netRefused + s.bprFailed, s.bprRequests);
}

/** /pii 的状态：一行、" · " 分隔（部分客户端的通知气泡不保留换行），只说用户关心的。 */
function status(rt: Runtime, used: ReadonlyMap<Kind, ReadonlySet<string>>): { text: string; level: Level } {
  if (envDisabled()) return { text: "PII 保护已关闭（OMP_PII_GUARD=off，去掉环境变量并重启 omp 才能开启）· 请求将原样发出", level: "info" };
  if (rt.userOff) return { text: `PII 保护已关闭（/pii off）· 请求将原样发出${rt.noRestore ? " · 还原已关闭（PII_GUARD_NO_RESTORE，测试用）" : "，回复中的占位符仍会还原"}`, level: "info" };
  const parts = ["PII 保护已开启"];
  let warn = false;
  if (rt.guard) parts.push("模型就绪");
  else if (rt.setupP) parts.push("模型准备中（/pii setup）");
  else if (rt.guardErr) {
    warn = true;
    parts.push(`⚠ 模型不可用：${rt.guardErr.replace(/^模型加载失败：/, "")}`);
  } else parts.push(rt.guardP ? "模型加载中" : "模型将在首次请求时加载");
  const counts = ALL_KINDS.filter((k) => used.get(k)?.size).map((k) => `${KIND_ZH[k]} ${used.get(k)!.size}`);
  parts.push(counts.length > 0 ? `本会话已遮挡：${counts.join("、")}` : "本会话还没有需要遮挡的内容");
  parts.push(`已检查 ${checkedRequests(rt.stats)} 个请求`);
  if (rt.stats.failures > 0) {
    warn = true;
    parts.push(`失败 ${rt.stats.failures} 次`);
  }
  const problems = transportProblems();
  if (problems.length > 0) {
    warn = true;
    parts.push(`⚠ 网络层未就位（${problems.join("、")}），直连请求可能不受保护`);
  }
  if (rt.config.threshold !== DEFAULT_THRESHOLD) parts.push(`阈值 ${rt.config.threshold}`);
  if (rt.config.kinds.size < ALL_KINDS.length) parts.push(`只遮：${ALL_KINDS.filter((k) => rt.config.kinds.has(k)).map((k) => KIND_ZH[k]).join("、")}`);
  if (rt.noRestore) parts.push("还原已关闭（PII_GUARD_NO_RESTORE，测试用）");
  return { text: parts.join(" · "), level: warn ? "warning" : "info" };
}
