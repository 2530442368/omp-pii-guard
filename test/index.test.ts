// 扩展入口：用假的 pi/ctx 驱动处理器，验证出口遮挡、失败策略、还原、映射持久化与开关。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piiGuard, { hidePartialPlaceholder, testHooks } from "../src/index.ts";
import { Masker } from "../src/mask.ts";
import { FakeRecognizer, VALUES } from "./fake.ts";

type Handler = (event: any, ctx: any) => any;

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const entries: { type: string; data: any }[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const renderers: ((r: { text: string; streaming: boolean }) => string | undefined)[] = [];
  const pi = {
    setLabel() {},
    on(ev: string, h: Handler) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
    },
    registerCommand(name: string, o: any) {
      commands.set(name, o);
    },
    registerAssistantTextRenderer(fn: any) {
      renderers.push(fn);
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
    logger: { debug() {} },
  };
  const emit = async (ev: string, event: any, ctx: any) => {
    let last: any;
    for (const h of handlers.get(ev) ?? []) last = await h(event, ctx);
    return last;
  };
  return { pi, handlers, entries, commands, renderers, emit };
}

function makeCtx(over: Record<string, any> = {}) {
  const notes: { msg: string; level: string }[] = [];
  const branch: any[] = over.branch ?? [];
  const ctx = {
    model: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    hasUI: true,
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
    sessionManager: { getBranch: () => branch },
    setTimeout: (fn: () => unknown, ms: number) => setTimeout(() => void Promise.resolve(fn()).catch(() => {}), ms),
    ...over,
  };
  return { ctx, notes, branch };
}

const anthropicPayload = () => ({
  model: "claude",
  max_tokens: 10,
  system: [{ type: "text", text: "系统" }],
  messages: [
    { role: "user", content: "我叫张伟，手机 13812345678，别说出去。 $$ABCD1234EFGH:L$$" },
    { role: "assistant", content: [{ type: "thinking", thinking: "张伟", signature: "sig" }, { type: "text", text: "好的" }] },
  ],
});

let dir: string;
const savedEnv = { ...process.env };

function fresh(values: Record<string, string> = VALUES) {
  testHooks.reset();
  const rt = testHooks.runtime();
  const rec = new FakeRecognizer(values);
  rt.masker = new Masker(async () => rec, rt.ph, () => rt.config);
  return { rt, rec };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-idx-"));
  process.env.PII_GUARD_DIR = dir;
  delete process.env.OMP_PII_GUARD;
  delete process.env.PII_GUARD_NO_RESTORE;
  delete process.env.PII_GUARD_MODEL_DIR;
  testHooks.reset();
});
afterEach(() => {
  testHooks.reset();
  process.env = { ...savedEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("出口遮挡 before_provider_request", () => {
  test("遮挡文本、保留 thinking/签名/$$…$$；映射写进会话；同一会话不重复写", async () => {
    const { rt } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    const payload = anthropicPayload();
    const r = await t.emit("before_provider_request", { payload }, ctx);
    expect(r).toBeUndefined();
    const text = payload.messages[0]!.content as string;
    expect(text).not.toContain("13812345678");
    expect(text).toContain("$$ABCD1234EFGH:L$$");
    expect(text).toMatch(/\{\{PHONE_[a-z2-7]{8}\}\}/);
    expect((payload.messages[1]!.content as any[])[0]).toEqual({ type: "thinking", thinking: "张伟", signature: "sig" });
    expect(t.entries.length).toBe(1);
    expect(t.entries[0]!.type).toBe("pii-guard.map");
    const values = t.entries[0]!.data.e.map((x: any) => x.value).sort();
    expect(values).toContain("13812345678");
    // 往返
    expect(rt.ph.restoreText(text)).toContain("13812345678");
    // 第二次请求（同样内容）：不再写
    await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    expect(t.entries.length).toBe(1);
    // 第二个会话（子代理：工厂重跑）自己的映射条目也要写
    const t2 = makePi();
    piiGuard(t2.pi);
    await t2.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    expect(t2.entries.length).toBe(1);
  });

  test("openai-responses 与 codex 的格式", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    for (const api of ["openai-responses", "openai-codex-responses"]) {
      const { ctx } = makeCtx({ model: { api, baseUrl: "https://chatgpt.com/backend-api" } });
      const payload = { model: "m", input: [{ type: "function_call", call_id: "c", name: "write", arguments: JSON.stringify({ content: "手机 13812345678" }) }] };
      await t.emit("before_provider_request", { payload }, ctx);
      expect(JSON.parse(payload.input[0]!.arguments).content).toMatch(/\{\{PHONE_/);
    }
  });

  test("识别失败 → return {}（不放行原文），提示含原因与关闭方法", async () => {
    const { rec } = fresh();
    rec.failWith = new Error("模型坏了");
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    const payload = anthropicPayload();
    const r = await t.emit("before_provider_request", { payload }, ctx);
    expect(r).toEqual({});
    expect(payload.messages[0]!.content).toContain("13812345678"); // 没写回：但不会发出，因为返回了 {}
    expect(notes[0]!.level).toBe("error");
    expect(notes[0]!.msg).toContain("模型坏了");
    expect(notes[0]!.msg).toContain("/pii off");
    expect(notes[0]!.msg).toContain("OMP_PII_GUARD=off");
  });

  test("未知 api（devin-agent 等）→ fail-closed", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    for (const api of ["devin-agent", "google-generative-ai", undefined]) {
      const { ctx, notes } = makeCtx({ model: { api } });
      const r = await t.emit("before_provider_request", { payload: { x: "张伟" } }, ctx);
      expect(r).toEqual({});
      expect(notes.at(-1)!.msg).toContain("不支持的请求格式");
    }
  });

  test("超时：网络层在位且请求可识别 → 放行交给网络层；否则 {}", async () => {
    const { rt, rec } = fresh();
    rec.delayMs = 150;
    rt.bprBudgetMs = 20;
    const t = makePi();
    piiGuard(t.pi); // 装网络层
    const { ctx } = makeCtx();
    const payload = anthropicPayload();
    expect(await t.emit("before_provider_request", { payload }, ctx)).toBeUndefined();
    expect(payload.messages[0]!.content).toContain("13812345678"); // 没改：交给网络层
    expect(rt.stats.bprFallbackToNet).toBe(1);
    // 请求认不出来：网络层也认不出，必须 {}
    expect(await t.emit("before_provider_request", { payload: { messages: [{ role: "user", content: "张伟 13812345678" }] } }, ctx)).toEqual({});
    // 网络层包装缺失：{}
    const real = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response("x");
    try {
      expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toEqual({});
    } finally {
      globalThis.fetch = real;
    }
  });

  test("/pii off：原样放行；/pii on 恢复", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.commands.get("pii")!.handler("off", ctx);
    const p1 = anthropicPayload();
    expect(await t.emit("before_provider_request", { payload: p1 }, ctx)).toBeUndefined();
    expect(p1.messages[0]!.content).toContain("13812345678");
    await t.commands.get("pii")!.handler("on", ctx);
    const p2 = anthropicPayload();
    await t.emit("before_provider_request", { payload: p2 }, ctx);
    expect(p2.messages[0]!.content).not.toContain("13812345678");
    expect(notes.some((n) => n.msg.includes("已关闭"))).toBe(true);
  });

  test("OMP_PII_GUARD=off：不注册钩子，只有 /pii，提示已关闭", async () => {
    process.env.OMP_PII_GUARD = "off";
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    expect(t.handlers.has("before_provider_request")).toBe(false);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(notes[0]!.msg).toContain("OMP_PII_GUARD=off");
    await t.commands.get("pii")!.handler("on", ctx);
    expect(notes.at(-1)!.msg).toContain("OMP_PII_GUARD=off");
    await t.commands.get("pii")!.handler("", ctx);
    expect(notes.at(-1)!.msg).toContain("已关闭（OMP_PII_GUARD=off");
    expect(notes.at(-1)!.msg).not.toContain("\n");
    expect(notes.at(-1)!.level).toBe("info");
  });
});

describe("A6：模型文件缺失/损坏", () => {
  test("目录不存在 → 请求被阻止，提示明确", async () => {
    process.env.PII_GUARD_MODEL_DIR = path.join(dir, "nonexistent");
    testHooks.reset(); // 用真识别器
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    const r = await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    expect(r).toEqual({});
    expect(notes[0]!.msg).toContain("模型");
    expect(notes[0]!.msg).toContain("缺失");
    expect(notes[0]!.msg).toContain("/pii setup"); // 拒发提示指向 /pii setup
    expect(notes[0]!.msg).toContain("OMP_PII_GUARD=off");
    // 关掉后正常
    await t.commands.get("pii")!.handler("off", ctx);
    expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toBeUndefined();
  });

  test("文件损坏（大小与 sha256 不符）→ 阻止", async () => {
    const m = path.join(dir, "model");
    fs.mkdirSync(m);
    for (const f of ["model_int8.onnx", "model_int8.onnx_data", "tokenizer.json"]) fs.writeFileSync(path.join(m, f), "garbage");
    process.env.PII_GUARD_MODEL_DIR = m;
    testHooks.reset();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toEqual({});
    expect(notes[0]!.msg).toContain("不符");
    expect(notes[0]!.msg).toContain("/pii setup");
  });

  test("session_start 预热失败：提示模型未就绪", async () => {
    process.env.PII_GUARD_MODEL_DIR = path.join(dir, "nonexistent");
    testHooks.reset();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await Bun.sleep(200);
    expect(notes.some((n) => n.level === "error" && n.msg.includes("缺失") && n.msg.includes("/pii setup"))).toBe(true); // 启动提示指向 /pii setup
  });
});

describe("还原", () => {
  async function withMapping() {
    const { rt } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    const payload = anthropicPayload();
    await t.emit("before_provider_request", { payload }, ctx);
    const ph = (payload.messages[0]!.content as string).match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    const person = (payload.messages[0]!.content as string).match(/\{\{PERSON_[a-z2-7]{8}\}\}/)?.[0];
    return { rt, t, ctx, ph, person };
  }

  test("tool_call：参数里的占位符换回原值（深度）", async () => {
    const { t, ctx, ph } = await withMapping();
    const r = await t.emit("tool_call", { toolName: "write", input: { path: "/tmp/x", content: `电话 ${ph}`, nested: { a: [ph] } } }, ctx);
    expect(r.input).toEqual({ path: "/tmp/x", content: "电话 13812345678", nested: { a: ["13812345678"] } });
  });

  test("tool_call：不还原清单；read 的 URL 不还原；无占位符不返回", async () => {
    const { t, ctx, ph, rt } = await withMapping();
    for (const toolName of ["web_search", "generate_image", "fetch", "browser_open", "web_fetch"]) {
      expect(await t.emit("tool_call", { toolName, input: { query: ph } }, ctx)).toBeUndefined();
    }
    // 目标是外部 URL：整个调用不还原
    expect(await t.emit("tool_call", { toolName: "read", input: { path: `https://x.com/${ph}`, other: ph } }, ctx)).toBeUndefined();
    // 目标在本机：其他叶子照常还原，URL 形态的叶子仍不还原
    const r = await t.emit("tool_call", { toolName: "read", input: { path: "/tmp/a.txt", link: `https://x.com/${ph}`, other: ph } }, ctx);
    expect(r.input).toEqual({ path: "/tmp/a.txt", link: `https://x.com/${ph}`, other: "13812345678" });
    expect(await t.emit("tool_call", { toolName: "write", input: { content: "无" } }, ctx)).toBeUndefined();
    rt.config.noRestoreTools = ["my_tool"];
    expect(await t.emit("tool_call", { toolName: "my_tool", input: { q: ph } }, ctx)).toBeUndefined();
  });

  test("assistant_message：文本块还原，其他块与块数量不变", async () => {
    const { t, ctx, ph } = await withMapping();
    const message = { content: [{ type: "thinking", thinking: `想 ${ph}` }, { type: "text", text: `号码是 ${ph}` }, { type: "toolCall", id: "t", name: "w", arguments: { a: ph } }] };
    const r = await t.emit("assistant_message", { message }, ctx);
    expect(r.content.length).toBe(3);
    expect(r.content[0]).toBe(message.content[0]); // 同一引用：thinking 不动
    expect(r.content[1]).toEqual({ type: "text", text: "号码是 13812345678" });
    expect(r.content[2]).toBe(message.content[2]);
    expect(await t.emit("assistant_message", { message: { content: [{ type: "text", text: "无" }] } }, ctx)).toBeUndefined();
  });

  test("渲染器：流式时还原并隐藏行尾未闭合的 {{…", async () => {
    const { t, ph } = await withMapping();
    const render = t.renderers[0]!;
    expect(render({ text: `号码 ${ph}`, streaming: true })).toBe("号码 13812345678");
    expect(render({ text: "无", streaming: false })).toBeUndefined();
    expect(render({ text: "号码 {{PHONE_ab", streaming: true })).toBe("号码 ");
    expect(render({ text: "号码 {{PHONE_ab", streaming: false })).toBeUndefined(); // 终态不隐藏
    expect(hidePartialPlaceholder("a {")).toBe("a ");
    expect(hidePartialPlaceholder("a {{")).toBe("a ");
    expect(hidePartialPlaceholder("a {{PHONE_abcdefgh}}")).toBe("a {{PHONE_abcdefgh}}");
    expect(hidePartialPlaceholder("a {x}")).toBe("a {x}");
  });

  test("PII_GUARD_NO_RESTORE=1：关闭所有还原", async () => {
    process.env.PII_GUARD_NO_RESTORE = "1";
    const { rt } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    const payload = anthropicPayload();
    await t.emit("before_provider_request", { payload }, ctx);
    const ph = (payload.messages[0]!.content as string).match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    expect(rt.noRestore).toBe(true);
    expect(await t.emit("tool_call", { toolName: "write", input: { c: ph } }, ctx)).toBeUndefined();
    expect(await t.emit("assistant_message", { message: { content: [{ type: "text", text: ph }] } }, ctx)).toBeUndefined();
    expect(t.renderers[0]!({ text: ph, streaming: false })).toBeUndefined();
  });
});

describe("映射持久化与重建", () => {
  test("新进程从会话分支的 custom 条目重建，--resume 后仍能还原；branch/tree 事件同样重建", async () => {
    // 进程 A：遮挡并持久化
    fresh();
    const a = makePi();
    piiGuard(a.pi);
    const { ctx } = makeCtx();
    const payload = anthropicPayload();
    await a.emit("before_provider_request", { payload }, ctx);
    const ph = (payload.messages[0]!.content as string).match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    const saved = a.entries.map((e, i) => ({ type: "custom", customType: e.type, data: e.data, id: String(i) }));

    // 进程 B：全新运行时（映射为空），从分支重建
    testHooks.reset();
    const b = makePi();
    piiGuard(b.pi);
    expect(testHooks.runtime().ph.restoreText(ph)).toBe(ph);
    const { ctx: ctxB } = makeCtx({ branch: [{ type: "message", message: { role: "user", content: "hi" } }, ...saved] });
    await b.emit("session_start", {}, ctxB);
    const r = await b.emit("tool_call", { toolName: "write", input: { c: ph } }, ctxB);
    expect(r.input).toEqual({ c: "13812345678" });

    // 进程 C：只触发 session_branch / session_tree
    for (const ev of ["session_branch", "session_tree", "session_switch"]) {
      testHooks.reset();
      const c = makePi();
      piiGuard(c.pi);
      const { ctx: ctxC } = makeCtx({ branch: saved });
      await c.emit(ev, {}, ctxC);
      expect((await c.emit("tool_call", { toolName: "write", input: { c: ph } }, ctxC)).input).toEqual({ c: "13812345678" });
    }
  });

  test("已持久化的占位符不会再写；换分支后重新判断", async () => {
    fresh();
    const a = makePi();
    piiGuard(a.pi);
    const { ctx } = makeCtx();
    await a.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    const saved = a.entries.map((e, i) => ({ type: "custom", customType: e.type, data: e.data, id: String(i) }));
    const { ctx: ctx2 } = makeCtx({ branch: saved });
    await a.emit("session_branch", {}, ctx2);
    const n = a.entries.length;
    await a.emit("before_provider_request", { payload: anthropicPayload() }, ctx2);
    expect(a.entries.length).toBe(n);
    // 切到没有这些条目的分支：下次请求要重新写
    const { ctx: ctx3 } = makeCtx({ branch: [] });
    await a.emit("session_tree", {}, ctx3);
    await a.emit("before_provider_request", { payload: anthropicPayload() }, ctx3);
    expect(a.entries.length).toBe(n + 1);
  });
});

describe("/pii setup", () => {
  const cache = path.join(os.homedir(), ".cache/magpie/astrlink-guard/7216b6a3b897");
  const haveCache = fs.existsSync(path.join(cache, "model_int8.onnx_data"));
  const real = haveCache ? test : test.skip;
  const waitSetup = async () => {
    for (let i = 0; i < 400 && testHooks.runtime().setupP; i++) await Bun.sleep(25);
  };

  real("A3：模型缺失 → /pii setup 复制缓存、校验、立即加载 → 无需重启即可遮挡；/pii 显示模型就绪", async () => {
    process.env.PII_GUARD_MODEL_DIR = path.join(dir, "model");
    process.env.PII_GUARD_MODEL_SRC = cache;
    testHooks.reset(); // 真识别器
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toEqual({}); // 没有模型：拒发
    await t.commands.get("pii")!.handler("setup", ctx);
    expect(notes.at(-1)!.msg).toContain("开始准备模型");
    expect((await t.commands.get("pii")!.handler("", ctx), notes.at(-1)!.msg)).toContain("模型准备中");
    await waitSetup();
    const done = notes.at(-1)!;
    expect(done.level).toBe("info");
    expect(done.msg).toContain("模型就绪");
    expect(done.msg).toContain("复制 3 个");
    expect(done.msg).toContain("无需重启");
    expect(fs.readdirSync(path.join(dir, "model")).sort()).toEqual(["model_int8.onnx", "model_int8.onnx_data", "tokenizer.json"]);
    await t.commands.get("pii")!.handler("", ctx);
    expect(notes.at(-1)!.msg).toContain("模型就绪");
    expect(notes.at(-1)!.msg).not.toContain("⚠");
    const p = anthropicPayload();
    expect(await t.emit("before_provider_request", { payload: p }, ctx)).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("13812345678"); // 真模型已在遮挡，没有重启
    // 模型齐全时再执行：不联网，直接成功
    await t.commands.get("pii")!.handler("setup", ctx);
    await waitSetup();
    expect(notes.at(-1)!.msg).toContain("已有 3 个");
  }, 60_000);

  test("A3：进行中再次执行 /pii setup 不会并发下载；失败后可重试，/pii 仍提示模型不可用并指向 /pii setup", async () => {
    process.env.PII_GUARD_MODEL_DIR = path.join(dir, "model");
    process.env.PII_GUARD_MODEL_SRC = path.join(dir, "no-cache");
    testHooks.reset();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    const urls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (u: string) => {
      urls.push(String(u));
      await gate;
      return new Response("nope", { status: 503 });
    };
    try {
      await t.commands.get("pii")!.handler("setup", ctx);
      await t.commands.get("pii")!.handler("setup", ctx);
      await t.commands.get("pii")!.handler("setup", ctx);
      expect(notes.filter((n) => n.msg.includes("开始准备模型")).length).toBe(1);
      expect(notes.filter((n) => n.msg.includes("已在进行中")).length).toBe(2);
      release();
      await waitSetup();
      expect(urls.length).toBe(1); // 只发起了一次下载（第一个文件失败即停）
      expect(urls[0]).toMatch(/^https:\/\/huggingface\.co\/QuantumNous\/astrlink-guard\/resolve\/7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4\/int8\/model_int8\.onnx$/);
      expect(notes.at(-1)!.level).toBe("error");
      expect(notes.at(-1)!.msg).toContain("模型准备失败");
      expect(notes.at(-1)!.msg).toContain("HTTP 503");
      expect(fs.readdirSync(path.join(dir, "model"))).toEqual([]); // 无残留
      expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toEqual({}); // 仍没有模型：拒发
      await t.commands.get("pii")!.handler("", ctx);
      expect(notes.at(-1)!.level).toBe("warning");
      expect(notes.at(-1)!.msg).toContain("/pii setup");
      // 可重试（setupP 已清掉）
      await t.commands.get("pii")!.handler("setup", ctx);
      expect(notes.at(-1)!.msg).toContain("开始准备模型");
      await waitSetup();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("用法提示含 setup；OMP_PII_GUARD=off 时 /pii setup 不联网，说明已全局关闭", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.commands.get("pii")!.handler("bogus", ctx);
    expect(notes.at(-1)!.msg).toContain("/pii setup");
    process.env.OMP_PII_GUARD = "off";
    const realFetch = globalThis.fetch;
    let called = 0;
    (globalThis as any).fetch = async () => {
      called++;
      return new Response("x");
    };
    try {
      await t.commands.get("pii")!.handler("setup", ctx);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(called).toBe(0);
    expect(notes.at(-1)!.msg).toContain("OMP_PII_GUARD=off");
    expect(notes.at(-1)!.level).toBe("warning");
  });
});

describe("/pii 与自检", () => {
  async function pii(t: ReturnType<typeof makePi>, ctx: any, notes: { msg: string; level: string }[], args = "") {
    await t.commands.get("pii")!.handler(args, ctx);
    return notes.at(-1)!;
  }

  test("/pii（A1、A2）：单行、' · ' 分段；中文类别与不同值个数；不出现内部细节；未知参数给用法", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    const n = await pii(t, ctx, notes);
    expect(n.msg).not.toContain("\n");
    expect(n.msg.split(" · ").length).toBeGreaterThanOrEqual(4);
    expect(n.msg).toContain("已开启");
    expect(n.msg).toContain("模型");
    expect(n.msg).toMatch(/人名 1/);
    expect(n.msg).toMatch(/手机 1/);
    expect(n.msg).toContain("已检查 1 个请求");
    expect(n.level).toBe("info");
    // 正常状态不出现内部细节
    for (const internal of [dir, "目录", "线程", "出口", "转交", "网络层", "占位符映射", "PERSON", "PHONE", "ADDRESS", "EMAIL", "ACCOUNT", "SECRET", "失败", "⚠", "阈值", "只遮", "还原"]) expect(n.msg).not.toContain(internal);
    expect((await pii(t, ctx, notes, "bogus")).msg).toContain("用法");
  });

  test("/pii：本会话还没有遮挡内容时有明确说法；模型三种非错误状态（尚未加载 / 加载中 / 就绪）", async () => {
    const { rt } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    let n = await pii(t, ctx, notes);
    expect(n.msg).toContain("还没有需要遮挡的内容");
    expect(n.msg).toContain("已检查 0 个请求");
    expect(n.msg).toContain("首次请求时加载");
    expect(n.level).toBe("info");
    rt.guardP = new Promise(() => {});
    expect((await pii(t, ctx, notes)).msg).toContain("模型加载中");
    rt.guard = { threads: 4 } as any;
    n = await pii(t, ctx, notes);
    expect(n.msg).toContain("模型就绪");
    expect(n.msg).not.toContain("线程");
  });

  test("/pii（A4）：同一请求经出口处理器与网络层只计 1 次；直连请求（只过网络层）各计 1 次", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    const { getTransport } = await import("../src/transport.ts");
    const netMask = () => getTransport().deps!.maskBody("anthropic-messages", anthropicPayload());
    // 主会话请求：先过出口，再过网络层
    await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    await netMask();
    expect((await pii(t, ctx, notes)).msg).toContain("已检查 1 个请求");
    // 标题直连：只过网络层
    await netMask();
    expect((await pii(t, ctx, notes)).msg).toContain("已检查 2 个请求");
    // 第二个主会话请求
    await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    await netMask();
    expect((await pii(t, ctx, notes)).msg).toContain("已检查 3 个请求");
  });

  test("/pii（A4）：出口放行但请求没发出去（没到网络层）：仍计 1 次；不会多计", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
    expect((await pii(t, ctx, notes)).msg).toContain("已检查 2 个请求");
  });

  test("/pii（A3）：模型不可用 + 失败：⚠ 与原因、失败次数出现，级别 warning；出口失败的请求只计 1 次", async () => {
    process.env.PII_GUARD_MODEL_DIR = path.join(dir, "nonexistent");
    testHooks.reset();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toEqual({});
    const n = await pii(t, ctx, notes);
    expect(n.level).toBe("warning");
    expect(n.msg).toContain("⚠ 模型不可用");
    expect(n.msg).toContain("/pii setup"); // 状态里的原因指向 /pii setup
    expect(n.msg).toContain("nonexistent"); // 原因里带路径，才知道缺什么
    expect(n.msg).toContain("失败 1 次");
    expect(n.msg).toContain("已检查 1 个请求");
    expect(n.msg).not.toContain("\n");
  });

  /** 本机的“LLM 服务”：登记成已知来源（strict），返回 200。 */
  async function withLlmServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const http = await import("node:http");
    const { addLlmOrigin, getTransport, originOf } = await import("../src/transport.ts");
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => res.end("ok"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    addLlmOrigin(base);
    try {
      return await fn(base);
    } finally {
      getTransport().origins.delete(originOf(base));
      await new Promise((r) => server.close(r));
    }
  }
  const llmJson = () => JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "你好" }] });

  test("/pii（返工 P2-2）：网络层在调用 maskBody 前就拒发的请求（认不出的体、坏 gzip、不支持的编码）也计入已检查，每个请求只计一次", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await withLlmServer(async (base) => {
      const post = (body: string | Uint8Array, headers: Record<string, string> = {}) => fetch(`${base}/v1/messages`, { method: "POST", headers, body });
      expect((await post("plain text")).status).toBe(422); // 认不出（不是 JSON）
      let n = await pii(t, ctx, notes);
      expect(n.msg).toContain("已检查 1 个请求");
      expect(n.msg).toContain("失败 1 次");
      expect((await post("not gzip", { "content-encoding": "gzip" })).status).toBe(422); // 坏 gzip
      expect((await post("zstd?", { "content-encoding": "zstd" })).status).toBe(422); // 不支持的编码
      n = await pii(t, ctx, notes);
      expect(n.msg).toContain("已检查 3 个请求");
      expect(n.msg).toContain("失败 3 次");
      expect((await post(llmJson(), { "content-type": "application/json" })).status).toBe(200); // 正常的：成功计 1 次
      expect((await pii(t, ctx, notes)).msg).toContain("已检查 4 个请求");
    });
  });

  test("/pii（返工 P2-2）：网络层遮挡失败（模型不可用）只计 1 次，不与失败重复；出口失败 + 随后被拒发的空壳请求合计 1 个请求", async () => {
    process.env.PII_GUARD_MODEL_DIR = path.join(dir, "nonexistent");
    testHooks.reset();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await withLlmServer(async (base) => {
      const post = (body: string) => fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body });
      // 直连请求：遮挡失败（模型不可用）→ 拒发
      expect((await post(llmJson())).status).toBe(422);
      let n = await pii(t, ctx, notes);
      expect(n.msg).toContain("已检查 1 个请求");
      expect(n.msg).toContain("失败 1 次");
      // 主会话请求：出口失败，omp 随后发出空壳 {"stream":true}，网络层拒发——还是这一个请求
      expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toEqual({});
      expect((await post('{"stream":true}')).status).toBe(422);
      n = await pii(t, ctx, notes);
      expect(n.msg).toContain("已检查 2 个请求");
      // 没有空壳的出口失败：同样计 1 个
      expect(await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx)).toEqual({});
      expect((await pii(t, ctx, notes)).msg).toContain("已检查 3 个请求");
    });
  });

  test("/pii（返工 P2-3）：请求里字面写的、映射表里没有的 {{PHONE_abcdefgh}} 不计入已遮挡；真实占位符计入", async () => {
    fresh({});
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    const literal = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "示例占位符 {{PHONE_abcdefgh}} 与 {{PERSON_zzzzzzzz}}" }] };
    await t.emit("before_provider_request", { payload: literal }, ctx);
    expect(literal.messages[0]!.content).toContain("{{PHONE_abcdefgh}}"); // 没有被改动
    const n = await pii(t, ctx, notes);
    expect(n.msg).toContain("还没有需要遮挡的内容");
    expect(n.msg).not.toContain("手机");
    expect(n.msg).not.toContain("人名");
    const { rt } = fresh();
    const t2 = makePi();
    piiGuard(t2.pi);
    const c2 = makeCtx();
    await t2.emit("before_provider_request", { payload: anthropicPayload() }, c2.ctx);
    const n2 = await pii(t2, c2.ctx, c2.notes);
    expect(n2.msg).toMatch(/手机 1/);
    expect(rt.ph.byPh.size).toBeGreaterThan(0);
  });

  test("/pii（返工 P2-1）：/pii off 且 PII_GUARD_NO_RESTORE=1：关闭摘要不写“仍会还原”，改为说明还原已关闭", async () => {
    process.env.PII_GUARD_NO_RESTORE = "1";
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.commands.get("pii")!.handler("off", ctx);
    const off = await pii(t, ctx, notes);
    expect(off.msg).toContain("已关闭（/pii off）");
    expect(off.msg).toContain("原样发出");
    expect(off.msg).not.toContain("仍会还原");
    expect(off.msg).toContain("还原已关闭");
    expect(off.msg).not.toContain("\n");
  });

  test("/pii（A3）：网络层未就位 ⚠；非默认阈值、类别非全部、还原关闭各自出现，级别 info（无 ⚠ 无失败）", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ threshold: 0.9, kinds: ["phone", "person"] }));
    process.env.PII_GUARD_NO_RESTORE = "1";
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    const n = await pii(t, ctx, notes);
    expect(n.msg).toContain("阈值 0.9");
    expect(n.msg).toContain("只遮：人名、手机");
    expect(n.msg).toContain("还原已关闭");
    expect(n.msg).not.toContain("⚠");
    expect(n.level).toBe("info");
    const real = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response("x");
    try {
      const w = await pii(t, ctx, notes);
      expect(w.msg).toContain("⚠");
      expect(w.msg).toContain("网络层未就位");
      expect(w.msg).toContain("fetch");
      expect(w.level).toBe("warning");
    } finally {
      globalThis.fetch = real;
    }
  });

  test("/pii（A3）：/pii off 与 OMP_PII_GUARD=off 的状态：关闭、请求原样发出、单行；/pii on 恢复", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.commands.get("pii")!.handler("off", ctx);
    const off = await pii(t, ctx, notes);
    expect(off.msg).toContain("已关闭（/pii off）");
    expect(off.msg).toContain("原样发出");
    expect(off.msg).toContain("占位符仍会还原");
    expect(off.msg).not.toContain("\n");
    expect(off.msg).not.toContain("已开启");
    await t.commands.get("pii")!.handler("on", ctx);
    expect((await pii(t, ctx, notes)).msg).toContain("已开启");
  });

  test("session_start：非 18.18.x 版本提示未验证；18.18.x 不提示；网络层缺失提示", async () => {
    fresh();
    const t = makePi();
    (t.pi as any).pi = { VERSION: "19.0.0" };
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(notes.some((n) => n.level === "warning" && n.msg.includes("网络层遮挡未在此 omp 版本验证"))).toBe(true);

    fresh();
    const t2 = makePi();
    (t2.pi as any).pi = { VERSION: "18.18.1" };
    piiGuard(t2.pi);
    const c2 = makeCtx();
    await t2.emit("session_start", {}, c2.ctx);
    expect(c2.notes.some((n) => n.msg.includes("未在此 omp 版本验证"))).toBe(false);

    fresh();
    const t3 = makePi();
    (t3.pi as any).pi = { VERSION: "18.18.1" };
    piiGuard(t3.pi);
    const real = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response("x");
    try {
      const c3 = makeCtx();
      await t3.emit("session_start", {}, c3.ctx);
      expect(c3.notes.some((n) => n.msg.includes("网络层包装不在位"))).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("配置：config.json 的 allow/kinds/阈值生效；坏配置回落默认并告警", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allow: ["13812345678"], kinds: ["phone"], threshold: 0.9 }));
    testHooks.reset();
    const rt = testHooks.runtime();
    expect(rt.config.threshold).toBe(0.9);
    expect([...rt.config.kinds]).toEqual(["PHONE"]);
    expect(rt.config.allow.has("13812345678")).toBe(true);
    fs.writeFileSync(path.join(dir, "config.json"), "{坏");
    testHooks.reset();
    expect(testHooks.runtime().config.warnings.length).toBe(1);
  });
});

describe("预扫描", () => {
  test("input / tool_result / assistant_message 到达时在后台识别，之后出口命中缓存", async () => {
    const { rec } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("input", { text: "手机 13812345678 请记住" }, ctx);
    await t.emit("tool_result", { content: [{ type: "text", text: "工具输出 13812345678 完" }] }, ctx);
    await Bun.sleep(100);
    expect(rec.calls.length).toBe(2);
    const payload = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "手机 13812345678 请记住" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "工具输出 13812345678 完" }] }] }] };
    await t.emit("before_provider_request", { payload }, ctx);
    expect(rec.calls.length).toBe(2); // 没有新的推理
    expect(payload.messages[0]!.content).toContain("{{PHONE_");
  });

  test("session_start 扫描整条分支（消息、工具参数、压缩摘要）", async () => {
    const { rec } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "第一条 张伟" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "write", arguments: { content: "参数 13812345678" } }] } },
      { type: "compaction", summary: "摘要 zhangwei@acme-corp.cn" },
    ];
    const { ctx } = makeCtx({ branch });
    await t.emit("session_start", {}, ctx);
    await Bun.sleep(150);
    expect(rec.calls.sort()).toEqual(["参数 13812345678", "摘要 zhangwei@acme-corp.cn", "第一条 张伟"].sort());
  });
});

describe("配置重读", () => {
  test("session_start 重读 config.json：改 allow 后新会话生效，坏配置给出提示", async () => {
    const { rt } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allow: ["13812345678"] }));
    await t.emit("session_start", {}, ctx);
    expect(rt.config.allow.has("13812345678")).toBe(true);
    const payload = anthropicPayload();
    await t.emit("before_provider_request", { payload }, ctx);
    expect(payload.messages[0]!.content).toContain("13812345678"); // 允许词不遮
    fs.writeFileSync(path.join(dir, "config.json"), "{坏");
    await t.emit("session_start", {}, ctx);
    expect(notes.some((n) => n.level === "warning" && n.msg.includes("不是合法 JSON"))).toBe(true);
  });
});

describe("A11：bpr 超时后由网络层完成遮挡", () => {
  test("bpr 放行（未改写）→ 同一请求经 fetch 发出时服务器收到的是占位符；推理只做一次", async () => {
    const { rt, rec } = fresh();
    rec.delayMs = 150;
    rt.bprBudgetMs = 20;
    const t = makePi();
    piiGuard(t.pi); // 装网络层，deps 指向本运行时
    const { ctx } = makeCtx();
    const payload = anthropicPayload();
    expect(await t.emit("before_provider_request", { payload }, ctx)).toBeUndefined();
    expect(JSON.stringify(payload)).toContain("13812345678"); // bpr 没来得及改

    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.text());
        return new Response("ok");
      },
    });
    try {
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } finally {
      server.stop(true);
    }
    expect(received.length).toBe(1);
    expect(received[0]).not.toContain("13812345678");
    expect(received[0]).toMatch(/\{\{PHONE_[a-z2-7]{8}\}\}/);
    expect(received[0]).toContain("$$ABCD1234EFGH:L$$");
    expect(rec.calls.filter((c) => c.includes("13812345678")).length).toBe(1); // bpr 起的推理被网络层复用
  });
});

describe("返工：还原策略（S-F1）", () => {
  async function setupMapping(restoreTools: string[] = []) {
    const { rt } = fresh();
    rt.config.restoreTools = restoreTools;
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    const payload = anthropicPayload();
    await t.emit("before_provider_request", { payload }, ctx);
    const ph = (payload.messages[0]!.content as string).match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    return { t, ctx, ph };
  }

  test("mcp__* 工具默认不还原；write 到 xd://mcp__… 与外部 scheme 不还原；本机目标照常", async () => {
    const { t, ctx, ph } = await setupMapping();
    expect(await t.emit("tool_call", { toolName: "mcp__figma_mcp_go_set_text", input: { text: ph } }, ctx)).toBeUndefined();
    expect(await t.emit("tool_call", { toolName: "write", input: { path: "xd://mcp__figma_mcp_go_set_text", content: JSON.stringify({ text: ph }) } }, ctx)).toBeUndefined();
    for (const p of ["ssh://host/~/a.txt", "https://x.example/y", "mcp://srv/r", "pr://1", "issue://2"]) {
      expect(await t.emit("tool_call", { toolName: "write", input: { path: p, content: ph } }, ctx)).toBeUndefined();
    }
    for (const p of ["local://plan.md", "agent://abc", "/tmp/x.txt", "xd://lsp"]) {
      const r = await t.emit("tool_call", { toolName: "write", input: { path: p, content: `电话 ${ph}` } }, ctx);
      expect(r.input.content).toBe("电话 13812345678");
    }
  });

  test("restoreTools 通配放行本地 MCP（及 write xd://<该工具>）", async () => {
    const { t, ctx, ph } = await setupMapping(["mcp__dbhub*"]);
    const r1 = await t.emit("tool_call", { toolName: "mcp__dbhub_demo_execute_sql", input: { sql: `where p='${ph}'` } }, ctx);
    expect(r1.input.sql).toBe("where p='13812345678'");
    const r2 = await t.emit("tool_call", { toolName: "write", input: { path: "xd://mcp__dbhub_demo_execute_sql", content: ph } }, ctx);
    expect(r2.input.content).toBe("13812345678");
    expect(await t.emit("tool_call", { toolName: "mcp__git_status", input: { q: ph } }, ctx)).toBeUndefined();
  });
});

describe("返工：网络层产生的映射随压缩持久化（R-P1）", () => {
  test("仅网络层遮挡 → session_compact 写入映射 → 新进程重建后可还原；条目带识别分数", async () => {
    const { rt } = fresh();
    rt.bprBudgetMs = 20; // bpr 不改，交给网络层
    rt.masker = new Masker(async () => Object.assign(new FakeRecognizer(VALUES), { delayMs: 0 }), rt.ph, () => rt.config);
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, branch } = makeCtx();
    // 网络层遮挡一个请求（没有 bpr、没有 noteUsed）
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.text());
        return new Response("ok");
      },
    });
    try {
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(anthropicPayload()) });
    } finally {
      server.stop(true);
    }
    const ph = received[0]!.match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    expect(t.entries.length).toBe(0); // 还没有任何映射写进会话

    // 压缩保存了含占位符的摘要，omp 触发 session_compact
    const compactionEntry = { type: "compaction", id: "c1", summary: `用户手机 ${ph}` };
    branch.push(compactionEntry);
    await t.emit("session_compact", { compactionEntry, fromExtension: false }, ctx);
    expect(t.entries.length).toBe(1);
    const e = t.entries[0]!;
    expect(e.type).toBe("pii-guard.map");
    const mine = e.data.e.find((x: any) => x.ph === ph);
    expect(mine.value).toBe("13812345678");
    expect(typeof mine.s).toBe("number");
    // 事件所属会话写入（不是“最后初始化的会话”）：另一个会话的 pi 不受影响
    const other = makePi();
    piiGuard(other.pi);
    expect(other.entries.length).toBe(0);
    await t.emit("session_compact", { compactionEntry, fromExtension: false }, ctx);
    expect(t.entries.length).toBe(1); // 已写过，不重复

    // 新进程：从会话分支重建后，摘要里的占位符能在工具参数里还原
    testHooks.reset();
    const b = makePi();
    piiGuard(b.pi);
    const saved = t.entries.map((x, i) => ({ type: "custom", customType: x.type, data: x.data, id: String(i) }));
    const { ctx: ctxB } = makeCtx({ branch: [compactionEntry, ...saved] });
    await b.emit("session_start", {}, ctxB);
    expect((await b.emit("tool_call", { toolName: "write", input: { c: ph } }, ctxB)).input).toEqual({ c: "13812345678" });
  });
});

describe("返工第 1 轮：持久化分数更新（R-P2）", () => {
  const scored = (rec: FakeRecognizer, score: (text: string) => number) => {
    const orig = rec.find.bind(rec);
    rec.find = async (text: string) => (await orig(text)).map((f) => ({ ...f, score: score(text) }));
  };
  const phonePayload = (text: string) => ({ model: "m", max_tokens: 1, messages: [{ role: "user", content: text }] });

  async function firstProcess() {
    const { rt, rec } = fresh();
    scored(rec, (text) => (text.includes("确认") ? 0.99 : 0.85));
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    const p1 = phonePayload("手机 13812345678");
    await t.emit("before_provider_request", { payload: p1 }, ctx);
    const ph = (p1.messages[0]!.content as string).match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    expect(rt.ph.scoreOf(ph)).toBe(0.85);
    expect(t.entries.length).toBe(1);
    expect(t.entries[0]!.data.e.find((x: any) => x.ph === ph).s).toBe(0.85);
    return { t, ctx, ph };
  }
  const saved = (t: ReturnType<typeof makePi>) => t.entries.map((e, i) => ({ type: "custom", customType: e.type, data: e.data, id: String(i) }));

  async function secondProcess(entries: any[], expectCovered: boolean) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ threshold: 0.95 }));
    const { rt, rec } = fresh();
    rec.find = async () => []; // 模型在别处什么也没找到：只有已知值补遮
    const b = makePi();
    piiGuard(b.pi);
    const { ctx } = makeCtx({ branch: entries });
    await b.emit("session_start", {}, ctx);
    expect(rt.config.threshold).toBe(0.95);
    const payload = phonePayload("转给 13812345678 吧");
    await b.emit("before_provider_request", { payload }, ctx);
    expect(/\{\{PHONE_/.test(payload.messages[0]!.content as string)).toBe(expectCovered);
  }

  test("低分持久化 → 同值被高分确认（追加更新）→ 提高阈值重启后仍补遮；只有低分记录则不补遮", async () => {
    const { t, ph } = await firstProcess();
    // 只有低分记录：0.85 < 阈值 0.95，重启后不补遮（对照）
    await secondProcess(saved(t), false);

    // 另一个进程（默认阈值）载入分支；同一值在另一段文本里被高分确认：分数提高 → 追加一条更新记录；再次出现不重复写
    fs.rmSync(path.join(dir, "config.json"));
    const { rec } = fresh();
    scored(rec, (text) => (text.includes("确认") ? 0.99 : 0.85));
    const t2 = makePi();
    piiGuard(t2.pi);
    const c2 = makeCtx({ branch: saved(t) });
    await t2.emit("session_start", {}, c2.ctx);
    const n0 = t2.entries.length;
    const p2 = phonePayload("请确认手机 13812345678");
    await t2.emit("before_provider_request", { payload: p2 }, c2.ctx);
    expect(t2.entries.length).toBe(n0 + 1);
    const upd = t2.entries.at(-1)!.data.e.find((x: any) => x.ph === ph);
    expect(upd.s).toBe(0.99);
    await t2.emit("before_provider_request", { payload: phonePayload("请确认手机 13812345678") }, c2.ctx);
    expect(t2.entries.length).toBe(n0 + 1); // 分数没再提高：不重复写

    // 两条记录（0.85 与 0.99）：重建时同一占位符合并取最高分，阈值 0.95 下重启补遮
    await secondProcess([...saved(t), ...saved(t2).slice(-1)], true);
  });
});

describe("返工第 1、2 轮：已知 LLM 服务（S-F7，按 origin）", () => {
  test("bpr 里的 ctx.model.baseUrl 与 ctx.models.list() 的 baseUrl 的 origin 进已知表；同主机别的端口不进", async () => {
    const { isKnownOrigin, getTransport, originOf } = await import("../src/transport.ts");
    const added = ["https://gw.example:8443", "http://10.1.2.3:9000", "https://relay.internal"];
    try {
      fresh();
      const t = makePi();
      piiGuard(t.pi);
      expect(isKnownOrigin("https://gw.example:8443/x")).toBe(false);
      const { ctx } = makeCtx({
        model: { api: "anthropic-messages", baseUrl: "https://gw.example:8443/v1" },
        models: { list: () => [{ baseUrl: "http://10.1.2.3:9000/v1" }, { baseUrl: "not a url" }, {}, { baseUrl: "https://relay.internal/v1" }] },
      });
      await t.emit("session_start", {}, ctx);
      expect(isKnownOrigin("https://gw.example:8443/messages")).toBe(true);
      expect(isKnownOrigin("http://10.1.2.3:9000/messages")).toBe(true);
      expect(isKnownOrigin("https://relay.internal/messages")).toBe(true);
      expect(isKnownOrigin("https://api.anthropic.com/messages")).toBe(true);
      // 同主机的别的端口、别的协议不是已知服务
      expect(isKnownOrigin("http://10.1.2.3:9001/messages")).toBe(false);
      expect(isKnownOrigin("http://10.1.2.3/messages")).toBe(false);
      expect(isKnownOrigin("https://gw.example/messages")).toBe(false);
      expect(isKnownOrigin("http://gw.example:8443/messages")).toBe(false);
      // bpr 里见到的也学
      getTransport().origins.delete(originOf("https://gw.example:8443"));
      await t.emit("before_provider_request", { payload: anthropicPayload() }, ctx);
      expect(isKnownOrigin("https://gw.example:8443/messages")).toBe(true);
    } finally {
      for (const o of added) getTransport().origins.delete(originOf(o));
    }
  });
});

describe("返工第 2 轮：$$…$$ 按来源信任（S-F2）", () => {
  const D = "$".repeat(2);
  const dollar = (inner: string) => `${D}${inner}${D}`;
  const Q = "Q7M2Z8P4R6T9";
  const Z = "ZZ9Y8X7W6V5U";
  const userText = (text: string) => ({ type: "message", id: "e1", message: { role: "user", content: text } });
  const req = (text: string) => ({ model: "m", max_tokens: 1, messages: [{ role: "user", content: text }] });

  async function run(branch: any[], text: string, extra: Record<string, any> = {}) {
    const { rt } = fresh({ [Q]: "common_secret", [Z]: "common_secret" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx({ branch, ...extra });
    const payload = req(text);
    await t.emit("before_provider_request", { payload }, ctx);
    return { rt, t, ctx, out: payload.messages[0]!.content as string };
  }

  test("本地会话里字面出现的 $$<12 位>$$（用户写的密码）：首次出现就被遮；本地没有的（omp 生成的）受保护并记入已确认集合", async () => {
    const typed = dollar(Q);
    const real = dollar(Z);
    const { rt, out } = await run([userText(`密码是 ${typed}`)], `密码是 ${typed}，令牌 ${real}`);
    expect(out).not.toContain(Q);
    expect(out).toMatch(/\{\{SECRET_[a-z2-7]{8}\}\}/);
    expect(out).toContain(real);
    expect(rt.confirmed.has(real)).toBe(true);
    expect(rt.confirmed.has(typed)).toBe(false);
  });

  test("各类本地条目里的字面 $$…$$ 都算：toolResult、custom_message、compaction、branch_summary、bashExecution、嵌套对象", async () => {
    const mk = (inner: string, entry: (s: string) => any) => ({ s: dollar(inner), entry });
    const cases = [
      mk("AAAA11112222", (s) => ({ type: "message", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: `out ${s}` }] } })),
      mk("BBBB11112222", (s) => ({ type: "custom_message", customType: "x", content: s })),
      mk("CCCC11112222", (s) => ({ type: "compaction", summary: `摘要 ${s}` })),
      mk("DDDD11112222", (s) => ({ type: "branch_summary", summary: s })),
      mk("EEEE11112222", (s) => ({ type: "message", message: { role: "bashExecution", command: "echo", output: s } })),
      mk("FFFF11112222", (s) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "write", arguments: { nested: { deep: [s] } } }] } })),
    ];
    const { rt } = fresh(Object.fromEntries(cases.map((c) => [c.s.slice(2, -2), "common_secret"])));
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx({ branch: cases.map((c) => c.entry(c.s)) });
    const payload = req(cases.map((c) => c.s).join(" 和 "));
    await t.emit("before_provider_request", { payload }, ctx);
    const out = payload.messages[0]!.content as string;
    for (const c of cases) expect(out).not.toContain(c.s.slice(2, -2));
    expect(rt.confirmed.size).toBe(0);
  });

  test("本地系统提示（ctx.getSystemPrompt）里字面出现的也算", async () => {
    const typed = dollar(Q);
    const { out } = await run([], `${typed} 在系统提示里写过`, { getSystemPrompt: () => `项目约定：${typed} 是示例口令` });
    expect(out).not.toContain(Q);
  });

  test("读不到本地会话（getBranch 抛错）：一个 $$…$$ 都不保护；没有 getSystemPrompt 也能工作", async () => {
    const real = dollar(Z);
    const { rt, out } = await run([], `令牌 ${real}`, { sessionManager: { getBranch: () => { throw new Error("坏了"); } } });
    expect(out).not.toContain(Z);
    expect(rt.confirmed.size).toBe(0);
    const ok = await run([], `令牌 ${real}`); // 没有 getSystemPrompt、分支为空
    expect(ok.out).toContain(real);
  });

  /** 把 leaf 包进 n 层嵌套对象（toolCall 参数里的深层结构）。 */
  const nested = (n: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = { x: v };
    return v;
  };
  const toolCallEntry = (args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "write", arguments: args }] } });

  test("返工第 3 轮 P1：20 层嵌套 toolCall 参数里的字面 $$…$$（超出扫描深度）首次出现就被遮；本次不新增确认", async () => {
    const typed = dollar(Q);
    const { rt, out } = await run([toolCallEntry(nested(20, typed))], `密码是 ${typed}`);
    expect(out).not.toContain(Q);
    expect(out).toMatch(/\{\{SECRET_[a-z2-7]{8}\}\}/);
    expect(rt.confirmed.size).toBe(0);
  });

  test("扫描不完整时：已确认集合里的照旧保护，其余严格格式 $$…$$ 照常识别且不新增确认；读不了的内容（Map）同样算不完整", async () => {
    const real = dollar(Z);
    const typed = dollar(Q);
    const { rt } = fresh({ [Q]: "common_secret", [Z]: "common_secret" });
    const t = makePi();
    piiGuard(t.pi);
    // 先在完整扫描下确认 real
    const branch: any[] = [userText("你好")];
    const { ctx } = makeCtx({ branch });
    await t.emit("before_provider_request", { payload: req(`令牌 ${real}`) }, ctx);
    expect(rt.confirmed.has(real)).toBe(true);
    // 之后分支里多了读不了的条目：Map 里藏着字面 typed
    branch.push({ type: "custom", data: new Map([["k", typed]]) });
    const p = req(`令牌 ${real}，口令 ${typed}`);
    await t.emit("before_provider_request", { payload: p }, ctx);
    const out = p.messages[0]!.content as string;
    expect(out).toContain(real); // 已确认的照旧保护
    expect(out).not.toContain(Q); // 没扫到不等于本地没有：不保护
    expect([...rt.confirmed]).toEqual([real]); // 没有新增确认
    // 同样的情形里，一个没确认过的“新”占位符也不保护、不确认
    const fresher = dollar("HHHH11112222");
    const rt2 = fresh({ HHHH11112222: "common_secret" }).rt;
    const t2 = makePi();
    piiGuard(t2.pi);
    const { ctx: ctx2 } = makeCtx({ branch: [{ type: "custom", data: new Map() }] });
    const p2 = req(`新令牌 ${fresher}`);
    await t2.emit("before_provider_request", { payload: p2 }, ctx2);
    expect(p2.messages[0]!.content).not.toContain("HHHH11112222");
    expect(rt2.confirmed.size).toBe(0);
  });

  test("系统提示读取失败也算扫描不完整：不新增确认", async () => {
    const real = dollar(Z);
    const { rt, out } = await run([userText("你好")], `令牌 ${real}`, { getSystemPrompt: () => { throw new Error("坏了"); } });
    expect(out).not.toContain(Z);
    expect(rt.confirmed.size).toBe(0);
  });

  test("同一文本，本地历史里有与没有，产出不同（缓存不串）", async () => {
    const typed = dollar(Q);
    const { rt } = fresh({ [Q]: "common_secret" });
    const t = makePi();
    piiGuard(t.pi);
    const entries: any[] = [];
    const { ctx } = makeCtx({ branch: entries });
    const p1 = req(`密码 ${typed}`);
    await t.emit("before_provider_request", { payload: p1 }, ctx);
    expect(p1.messages[0]!.content).toBe(`密码 ${typed}`); // 本地没有：当作 omp 的占位符保护
    entries.push(userText(`密码 ${typed}`)); // 之后本地历史里出现了（比如用户随后在会话里写了同样的字面串）
    const p2 = req(`密码 ${typed}`);
    await t.emit("before_provider_request", { payload: p2 }, ctx);
    expect(p2.messages[0]!.content).not.toContain(Q);
    void rt;
  });

  test("网络层只保护出口处理器确认过的 $$…$$：确认过的保留，字面出现的、没见过的都照常识别", async () => {
    const typed = dollar(Q);
    const real = dollar(Z);
    const unseen = dollar("GGGG11112222");
    const { rt } = fresh({ [Q]: "common_secret", [Z]: "common_secret", GGGG11112222: "common_secret" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx({ branch: [userText(`密码是 ${typed}`)] });
    await t.emit("before_provider_request", { payload: req(`密码是 ${typed}，令牌 ${real}`) }, ctx);
    expect([...rt.confirmed]).toEqual([real]);
    const { getTransport } = await import("../src/transport.ts");
    const body = req(`网络层：${typed} ${real} ${unseen}`);
    await getTransport().deps!.maskBody("anthropic-messages", body);
    const out = body.messages[0]!.content as string;
    expect(out).toContain(real);
    expect(out).not.toContain(Q);
    expect(out).not.toContain("GGGG11112222");
  });
});
