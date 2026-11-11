// Tern 状态文件：只在 Tern 里（有 TERN_PANE）由主会话的交互界面写；只含计数与状态，不含原值与占位符；
// 临时文件 + rename、0600、去抖、退出/关闭时删除、子代理与无界面会话不写、会话切换以新会话为准。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piiGuard, { testHooks } from "../src/index.ts";
import { Masker } from "../src/mask.ts";
import { ternPane, type TernFile } from "../src/tern.ts";
import { FakeRecognizer, VALUES } from "./fake.ts";

type Handler = (event: any, ctx: any) => any;

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const entries: { type: string; data: any }[] = [];
  const pi = {
    setLabel() {},
    on(ev: string, h: Handler) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
    },
    registerCommand(name: string, o: any) {
      commands.set(name, o);
    },
    registerAssistantTextRenderer() {},
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
  return { pi, commands, entries, emit };
}

function makeCtx(over: Record<string, any> = {}) {
  const notes: { msg: string; level: string }[] = [];
  const ctx = {
    model: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    hasUI: true,
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
    sessionManager: { getBranch: (): any[] => [] },
    setTimeout: (fn: () => unknown, ms: number) => setTimeout(() => void Promise.resolve(fn()).catch(() => {}), ms),
    ...over,
  };
  return { ctx, notes };
}

const payload = () => ({
  model: "claude",
  max_tokens: 10,
  messages: [{ role: "user", content: "我叫张伟，手机 13812345678，邮箱 zhangwei@acme-corp.cn。" }],
});

// 被测的是真实的去抖定时器（setTimeout），这里用真实时间等它走完：延迟已调到 10 ms，只有去抖用例等得更久。
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// 等待进行中的合并写走完（写是同步的，定时器触发即写完）：比固定睡眠在负载高时稳。只用于“应该写出来”的断言；
// “不应该写”的断言仍用固定睡眠，给假想中的写入足够的时间。
async function settle(): Promise<void> {
  const rt = testHooks.runtime();
  for (let i = 0; i < 400 && rt.tern?.pending; i++) await sleep(5);
  await sleep(5);
}

let dir: string;
let ternDir: string;
const savedEnv = { ...process.env };

function fresh(values: Record<string, string> = VALUES) {
  testHooks.reset();
  const rt = testHooks.runtime();
  const rec = new FakeRecognizer(values);
  rt.masker = new Masker(async () => rec, rt.ph, () => rt.config);
  // 模型“已就绪”：session_start 的预热直接用它，不去加载真模型
  rt.guard = rec as unknown as typeof rt.guard;
  rt.guardP = Promise.resolve(rec) as unknown as typeof rt.guardP;
  if (rt.tern) rt.tern.delayMs = 10;
  return { rt, rec };
}

const readState = (pane = 7): TernFile => JSON.parse(fs.readFileSync(path.join(ternDir, `${pane}.json`), "utf8"));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-tern-"));
  ternDir = path.join(dir, "tern");
  process.env.PII_GUARD_DIR = dir;
  process.env.TERN_PANE = "7";
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

describe("TERN_PANE", () => {
  test("只认正整数", () => {
    expect(ternPane({ TERN_PANE: "7" })).toBe(7);
    expect(ternPane({ TERN_PANE: "123456789012" })).toBe(123456789012);
    for (const v of [undefined, "", "0", "-1", "07", "abc", "../x", "1.5", " 7", "7/8", "99999999999999999"]) expect(ternPane({ TERN_PANE: v })).toBeUndefined();
  });
});

describe("只在 Tern 里写", () => {
  test("没有 TERN_PANE：什么都不写，连目录都不建", async () => {
    delete process.env.TERN_PANE;
    const { rt } = fresh();
    expect(rt.tern).toBeUndefined();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await t.emit("before_provider_request", { payload: payload() }, ctx);
    await sleep(60);
    expect(fs.existsSync(ternDir)).toBe(false);
  });

  test("TERN_PANE 不合法：不写", async () => {
    process.env.TERN_PANE = "../evil";
    const { rt } = fresh();
    expect(rt.tern).toBeUndefined();
  });

  test("子代理、无界面、非 TUI 的会话不写", async () => {
    fresh();
    for (const over of [{ hasUI: false }, { agent: { kind: "sub" } }, { mode: "print" }, { mode: "rpc" }]) {
      const t = makePi();
      piiGuard(t.pi);
      const { ctx } = makeCtx(over);
      await t.emit("session_start", {}, ctx);
      await t.emit("before_provider_request", { payload: payload() }, ctx);
      await sleep(60);
      expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(false);
    }
    // mode 为 tui 的主会话照常写
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx({ mode: "tui", agent: { kind: "main" } });
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(true);
  });
});

describe("内容", () => {
  test("遮挡后：字段、与 /pii 同一行摘要；不含原值、占位符", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    const p = payload();
    await t.emit("before_provider_request", { payload: p }, ctx);
    expect(JSON.stringify(p)).toMatch(/\{\{PHONE_/); // 确实遮了
    await settle();
    const raw = fs.readFileSync(path.join(ternDir, "7.json"), "utf8");
    const s: TernFile = JSON.parse(raw);
    expect(s.v).toBe(1);
    expect(s.pid).toBe(process.pid);
    expect(s.pane).toBe(7);
    expect(s.on).toBe(true);
    expect(s.off).toBeUndefined();
    expect(s.kinds).toEqual({ PERSON: 1, ADDRESS: 0, PHONE: 1, EMAIL: 1, ACCOUNT: 0, SECRET: 0 });
    expect(s.requests).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.level).toBe("info");
    expect(Math.abs(s.updatedAt - Date.now())).toBeLessThan(10_000);
    // 摘要与 /pii 的通知逐字相同
    await t.commands.get("pii")!.handler("", ctx);
    expect(s.summary).toBe(notes.at(-1)!.msg);
    expect(s.summary).toContain("人名 1");
    // 不含任何原值、占位符、会话内容
    for (const secret of ["张伟", "13812345678", "zhangwei", "acme-corp", "{{", "}}"]) expect(raw).not.toContain(secret);
    expect(Object.keys(s).sort()).toEqual(["failed", "kinds", "level", "model", "on", "pane", "pid", "requests", "summary", "updatedAt", "v"]);
  });

  test("开关与模型状态", async () => {
    const { rt } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(readState().model).toEqual({ state: "ready" });
    rt.guard = undefined;
    rt.guardP = undefined;
    rt.tern!.touch();
    await settle();
    expect(readState().model).toEqual({ state: "idle" });
    // 模型不可用：文件缺失类 / 其他
    rt.guardErr = "模型加载失败：模型文件不可用：缺少 model_int8.onnx";
    rt.tern!.touch();
    await settle();
    expect(readState().model).toEqual({ state: "unavailable", reason: "files" });
    expect(readState().level).toBe("warning");
    rt.guardErr = "模型加载失败：boom";
    rt.tern!.touch();
    await settle();
    expect(readState().model).toEqual({ state: "unavailable", reason: "other" });
    rt.guardErr = undefined;
    // /pii off、/pii on
    await t.commands.get("pii")!.handler("off", ctx);
    await settle();
    expect(readState()).toMatchObject({ on: false, off: "user", level: "info" });
    expect(readState().summary).toContain("已关闭");
    await t.commands.get("pii")!.handler("on", ctx);
    await settle();
    expect(readState()).toMatchObject({ on: true });
    expect(readState().off).toBeUndefined();
  });

  test("处理失败：failed 计数、level=warning", async () => {
    const { rec } = fresh();
    rec.failWith = new Error("模型坏了");
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(await t.emit("before_provider_request", { payload: payload() }, ctx)).toEqual({});
    await settle();
    const s = readState();
    expect(s.failed).toBe(1);
    expect(s.level).toBe("warning");
    expect(s.summary).toContain("失败 1 次");
    expect(s.kinds.PHONE).toBe(0);
  });

  test("OMP_PII_GUARD=off：也写出 on=false、off=env", async () => {
    process.env.OMP_PII_GUARD = "off";
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(readState()).toMatchObject({ on: false, off: "env" });
  });
});

describe("写入方式", () => {
  test("权限 0600、目录 0700、没有遗留临时文件", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await t.emit("before_provider_request", { payload: payload() }, ctx);
    await settle();
    expect(fs.statSync(path.join(ternDir, "7.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(ternDir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(ternDir)).toEqual(["7.json"]);
  });

  test("去抖：窗口内的多次变化合并成一次写；内容没变不重写", async () => {
    const { rt } = fresh();
    rt.tern!.delayMs = 120;
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    for (let i = 0; i < 5; i++) rt.tern!.touch();
    await t.emit("before_provider_request", { payload: payload() }, ctx);
    expect(rt.tern!.writes).toBe(0); // 还没到点
    await sleep(300);
    expect(rt.tern!.writes).toBe(1);
    expect(readState().requests).toBe(1);
    rt.tern!.touch(); // 没有变化
    await sleep(250);
    expect(rt.tern!.writes).toBe(1);
    await t.emit("before_provider_request", { payload: payload() }, ctx); // 请求数变了
    await sleep(300);
    expect(rt.tern!.writes).toBe(2);
    expect(readState().requests).toBe(2);
  });

  test("写不进去（目录被占用）不影响遮挡", async () => {
    fresh();
    fs.writeFileSync(ternDir, "占位的普通文件"); // tern 目录建不出来
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    const p = payload();
    expect(await t.emit("before_provider_request", { payload: p }, ctx)).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("13812345678");
    await sleep(60);
  });

  test("清掉 pid 已不存在的残留，不动活着的和别的文件", async () => {
    fresh();
    const dead = spawnSync("true").pid!; // 已退出的子进程的 pid
    fs.mkdirSync(ternDir, { recursive: true });
    const mk = (n: string, pid: number) => fs.writeFileSync(path.join(ternDir, n), JSON.stringify({ v: 1, pid, pane: 1 }));
    mk("3.json", dead);
    mk("4.json", process.pid);
    fs.writeFileSync(path.join(ternDir, "5.json"), "不是 JSON");
    fs.writeFileSync(path.join(ternDir, "notes.txt"), "别的文件");
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(fs.readdirSync(ternDir).sort()).toEqual(["4.json", "5.json", "7.json", "notes.txt"]);
  });
});

describe("删除", () => {
  test("session_shutdown 删文件", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(true);
    await t.emit("session_shutdown", {}, ctx);
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(false);
    await t.emit("before_provider_request", { payload: payload() }, ctx); // 关闭后不再写
    await settle();
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(false);
  });

  test("进程 exit 事件删文件；dispose 摘掉监听并删文件", async () => {
    const before = new Set(process.listeners("exit"));
    const { rt } = fresh();
    const added = process.listeners("exit").filter((l) => !before.has(l));
    expect(added.length).toBe(1);
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    const file = path.join(ternDir, "7.json");
    expect(fs.existsSync(file)).toBe(true);
    added[0]!(0); // 相当于进程退出
    expect(fs.existsSync(file)).toBe(false);
    rt.tern!.touch();
    await settle();
    expect(fs.existsSync(file)).toBe(true);
    testHooks.reset();
    expect(fs.existsSync(file)).toBe(false);
    expect(process.listeners("exit").filter((l) => !before.has(l)).length).toBe(0);
  });
});

describe("会话切换", () => {
  test("以后认领的会话为准；旧会话关闭不删新会话的文件", async () => {
    fresh();
    const t1 = makePi();
    piiGuard(t1.pi);
    const { ctx: ctx1 } = makeCtx();
    await t1.emit("session_start", {}, ctx1);
    await t1.emit("before_provider_request", { payload: payload() }, ctx1);
    await settle();
    expect(readState().kinds.PHONE).toBe(1);

    // 新会话（工厂重跑）：自己的 used 是空的
    const t2 = makePi();
    piiGuard(t2.pi);
    const { ctx: ctx2 } = makeCtx();
    await t2.emit("session_start", {}, ctx2);
    await settle();
    expect(readState().kinds).toEqual({ PERSON: 0, ADDRESS: 0, PHONE: 0, EMAIL: 0, ACCOUNT: 0, SECRET: 0 });

    await t1.emit("session_shutdown", {}, ctx1); // 旧会话收尾
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(true);
    await t2.emit("session_shutdown", {}, ctx2);
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(false);
  });

  test("子代理会话的事件不抢走认领", async () => {
    fresh();
    const t1 = makePi();
    piiGuard(t1.pi);
    const { ctx: main } = makeCtx();
    await t1.emit("session_start", {}, main);
    await t1.emit("before_provider_request", { payload: payload() }, main);
    const t2 = makePi();
    piiGuard(t2.pi);
    const { ctx: sub } = makeCtx({ agent: { kind: "sub" } });
    await t2.emit("session_start", {}, sub);
    await settle();
    expect(readState().kinds.PHONE).toBe(1);
  });
});

describe("真实的会话切换（工厂不重跑）", () => {
  test("同一工厂实例上 session_switch：计数按目标会话分支重建，状态文件与 /pii 随之变化", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    let branch: any[] = [];
    const { ctx, notes } = makeCtx();
    ctx.sessionManager.getBranch = () => branch;
    await t.emit("session_start", {}, ctx);
    await t.emit("before_provider_request", { payload: payload() }, ctx);
    await settle();
    const before = readState().kinds;
    expect(before).toEqual({ PERSON: 1, ADDRESS: 0, PHONE: 1, EMAIL: 1, ACCOUNT: 0, SECRET: 0 });
    expect(t.entries.length).toBe(1);
    const mapEntry = { type: "custom", customType: "pii-guard.map", data: t.entries[0]!.data };
    await t.commands.get("pii")!.handler("", ctx);
    const summaryBefore = notes.at(-1)!.msg;
    expect(summaryBefore).toContain("人名 1");

    // /new：目标会话没有映射条目 → 计数归零
    branch = [];
    await t.emit("session_switch", {}, ctx);
    await settle();
    expect(readState().kinds).toEqual({ PERSON: 0, ADDRESS: 0, PHONE: 0, EMAIL: 0, ACCOUNT: 0, SECRET: 0 });
    await t.commands.get("pii")!.handler("", ctx);
    expect(notes.at(-1)!.msg).toContain("本会话还没有需要遮挡的内容");
    expect(readState().summary).toBe(notes.at(-1)!.msg);

    // 切回有映射的会话 → 计数恢复
    branch = [mapEntry];
    await t.emit("session_switch", {}, ctx);
    await settle();
    expect(readState().kinds).toEqual(before);
    await t.commands.get("pii")!.handler("", ctx);
    expect(notes.at(-1)!.msg).toBe(summaryBefore.replace(/已检查 \d+ 个请求/, `已检查 ${readState().requests} 个请求`));
    expect(readState().summary).toBe(notes.at(-1)!.msg);

    // 分支切换（session_branch / session_tree）同理
    branch = [];
    await t.emit("session_branch", {}, ctx);
    await settle();
    expect(readState().kinds.PERSON).toBe(0);
    branch = [mapEntry];
    await t.emit("session_tree", {}, ctx);
    await settle();
    expect(readState().kinds).toEqual(before);
  });
});

describe("只删自己写的文件", () => {
  const other = () => spawnSync("true").pid!; // 另一个进程的 pid（已退出也无妨：只比较数值）
  const seed = (pid: number) => {
    fs.mkdirSync(ternDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ternDir, "7.json"), JSON.stringify({ v: 1, pid, pane: 7 }));
  };

  test("没认领/没写过的实例（如 omp -p）退出时不删别人的文件", async () => {
    const before = new Set(process.listeners("exit"));
    fresh();
    const added = process.listeners("exit").filter((l) => !before.has(l));
    seed(process.pid + 1);
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx({ hasUI: false }); // 无界面：不认领
    await t.emit("session_start", {}, ctx);
    await sleep(60);
    added[0]!(0); // 进程退出
    await t.emit("session_shutdown", {}, ctx);
    testHooks.reset(); // dispose
    expect(JSON.parse(fs.readFileSync(path.join(ternDir, "7.json"), "utf8")).pid).toBe(process.pid + 1);
  });

  test("写过之后文件被别的进程接管（pid 不同）：退出时不删", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(readState().pid).toBe(process.pid);
    seed(other()); // 另一个 omp 覆盖了同名文件
    await t.emit("session_shutdown", {}, ctx);
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(true);
    testHooks.reset();
    expect(fs.existsSync(path.join(ternDir, "7.json"))).toBe(true);
  });
});

describe("状态目录与临时文件的安全", () => {
  test("状态目录是符号链接：不写，也不往链接目标里写", async () => {
    fresh();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "pii-tern-target-"));
    try {
      fs.symlinkSync(target, ternDir);
      const t = makePi();
      piiGuard(t.pi);
      const { ctx } = makeCtx();
      await t.emit("session_start", {}, ctx);
      await t.emit("before_provider_request", { payload: payload() }, ctx);
      await sleep(80);
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test("状态目录权限过宽：收紧到 0700 再写", async () => {
    fresh();
    fs.mkdirSync(ternDir, { mode: 0o755 });
    fs.chmodSync(ternDir, 0o755);
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(fs.statSync(ternDir).mode & 0o777).toBe(0o700);
    expect(readState().pane).toBe(7);
  });

  test("预置的同名/旧式临时文件与符号链接不受影响；目标文件是符号链接时被替换而不是写穿", async () => {
    fresh();
    fs.mkdirSync(ternDir, { recursive: true, mode: 0o700 });
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "别动我");
    const oldTmp = path.join(ternDir, `7.json.${process.pid}.tmp`);
    fs.writeFileSync(oldTmp, "旧临时文件");
    const linkTmp = path.join(ternDir, "7.json.tmp");
    fs.symlinkSync(victim, linkTmp);
    fs.symlinkSync(victim, path.join(ternDir, "7.json")); // 最终文件名上也是指向受害文件的符号链接
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    await settle();
    expect(fs.readFileSync(victim, "utf8")).toBe("别动我");
    expect(fs.readFileSync(oldTmp, "utf8")).toBe("旧临时文件");
    expect(fs.lstatSync(linkTmp).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(ternDir, "7.json")).isFile()).toBe(true);
    expect(readState().pane).toBe(7);
    // 写过的临时文件都已 rename 走，除预置的两个外没有遗留
    expect(fs.readdirSync(ternDir).sort()).toEqual(["7.json", "7.json.tmp", `7.json.${process.pid}.tmp`].sort());
  });
});
