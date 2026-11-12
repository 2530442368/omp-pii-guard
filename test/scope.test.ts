// 预扫描范围（src/index.ts 的 sentTexts）：只扫分支上会发给模型的部分——最后一个 compaction 的摘要 +
// 从 firstKeptEntryId 起到分支末尾；映射恢复与计数仍用整条分支。用 FakeRecognizer.calls 观察被预扫描的文本。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piiGuard, { testHooks } from "../src/index.ts";
import { Masker } from "../src/mask.ts";
import { FakeRecognizer, VALUES } from "./fake.ts";

type Handler = (event: any, ctx: any) => any;

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const entries: { type: string; data: any }[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    setLabel() {},
    on(ev: string, h: Handler) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
    },
    registerCommand(name: string, o: any) {
      commands.set(name, o);
    },
    registerShortcut() {},
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
  return { pi, entries, commands, emit };
}

function makeCtx(branch: any[]) {
  const notes: { msg: string; level: string }[] = [];
  const ctx = {
    model: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    hasUI: true,
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
    sessionManager: { getBranch: () => branch },
    setTimeout: (fn: () => unknown, ms: number) => setTimeout(() => void Promise.resolve(fn()).catch(() => {}), ms),
  };
  return { ctx, notes };
}

// 条目构造
const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
const tool = (id: string, text: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: "t" + id, name: "write", arguments: { content: text } }] } });
const compaction = (id: string, summary: string, firstKeptEntryId?: unknown) => ({ type: "compaction", id, summary, ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }) });
const branchSummary = (id: string, summary: string) => ({ type: "branch_summary", id, fromId: "x", summary });
const custom = (id: string, content: string) => ({ type: "custom_message", id, customType: "x", content });

let dir: string;
const savedEnv = { ...process.env };

function fresh() {
  testHooks.reset();
  const rt = testHooks.runtime();
  const rec = new FakeRecognizer(VALUES);
  rt.masker = new Masker(async () => rec, rt.ph, () => rt.config);
  return { rt, rec };
}

/** 触发事件，等预扫描跑完，返回被识别过的文本（排序）。 */
async function scanned(event: string, branch: any[]): Promise<string[]> {
  const { rec } = fresh();
  const t = makePi();
  piiGuard(t.pi);
  const { ctx } = makeCtx(branch);
  await t.emit(event, {}, ctx);
  await Bun.sleep(200);
  return [...rec.calls].sort();
}

const sorted = (...xs: string[]) => [...xs].sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-scope-"));
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

describe("预扫描范围：只扫会发给模型的部分", () => {
  test("无压缩：整条分支（消息、工具参数、branch_summary、custom_message）", async () => {
    const branch = [user("a", "张伟"), tool("b", "乙 13812345678"), branchSummary("c", "丙 zhangwei@acme-corp.cn"), custom("d", "上海市浦东新区张江路500号")];
    expect(await scanned("session_start", branch)).toEqual(sorted("张伟", "乙 13812345678", "丙 zhangwei@acme-corp.cn", "上海市浦东新区张江路500号"));
  });

  test("一次压缩：摘要 + firstKeptEntryId 起到末尾；之前的条目不扫", async () => {
    const branch = [
      user("a", "旧一 张伟"),
      tool("b", "旧二 13812345678"),
      user("c", "保留一 张伟"),
      tool("d", "保留二 13812345678"),
      compaction("e", "摘要 zhangwei@acme-corp.cn", "c"),
      user("f", "之后 上海市浦东新区张江路500号"),
    ];
    expect(await scanned("session_start", branch)).toEqual(sorted("摘要 zhangwei@acme-corp.cn", "保留一 张伟", "保留二 13812345678", "之后 上海市浦东新区张江路500号"));
  });

  test("firstKeptEntryId 指向第一条：保留全部，加摘要", async () => {
    const branch = [user("a", "一 张伟"), user("b", "二 13812345678"), compaction("c", "摘要 zhangwei@acme-corp.cn", "a")];
    expect(await scanned("session_start", branch)).toEqual(sorted("一 张伟", "二 13812345678", "摘要 zhangwei@acme-corp.cn"));
  });

  test("多次压缩：只认最后一个的摘要；更早的摘要与保留区之前的内容不扫；保留区里更早的压缩条目本身不扫", async () => {
    const branch = [
      user("a", "最旧 张伟"),
      user("b", "第一次保留 13812345678"),
      compaction("c1", "第一次摘要 zhangwei@acme-corp.cn", "b"),
      user("d", "第一次之后 上海市浦东新区张江路500号"),
      user("e", "第二次之前 张伟"),
      compaction("c2", "第二次摘要 zhangwei@acme-corp.cn 二", "b"), // 保留区跨过更早的压缩条目 c1
      user("f", "第二次之后 13812345678"),
    ];
    expect(await scanned("session_start", branch)).toEqual(
      sorted("第二次摘要 zhangwei@acme-corp.cn 二", "第一次保留 13812345678", "第一次之后 上海市浦东新区张江路500号", "第二次之前 张伟", "第二次之后 13812345678"),
    );
    // 最旧的一条与第一次摘要都不在范围内
  });

  test("多次压缩：最后一次的 firstKeptEntryId 更靠后时，不回头扫第一次压缩之前的内容", async () => {
    const branch = [
      user("a", "最旧 张伟"),
      compaction("c1", "第一次摘要 zhangwei@acme-corp.cn", "a"),
      user("b", "中间 13812345678"),
      user("c", "靠后 上海市浦东新区张江路500号"),
      compaction("c2", "第二次摘要 zhangwei@acme-corp.cn 二", "c"),
    ];
    expect(await scanned("session_start", branch)).toEqual(sorted("第二次摘要 zhangwei@acme-corp.cn 二", "靠后 上海市浦东新区张江路500号"));
  });

  for (const [name, kept] of [
    ["缺失", undefined],
    ["不是字符串", 42],
    ["不在分支上", "不存在"],
    ["指向压缩条目自己", "c"],
    ["指向压缩之后的条目（位置异常）", "z"],
  ] as const) {
    test(`firstKeptEntryId ${name}：只扫摘要和压缩之后的条目`, async () => {
      const branch = [user("a", "旧 张伟"), user("b", "旧二 13812345678"), compaction("c", "摘要 zhangwei@acme-corp.cn", kept), user("z", "之后 上海市浦东新区张江路500号")];
      expect(await scanned("session_start", branch)).toEqual(sorted("摘要 zhangwei@acme-corp.cn", "之后 上海市浦东新区张江路500号"));
    });
  }

  test("压缩之后的 branch_summary / custom_message 与保留区里的 branch_summary 都扫", async () => {
    const branch = [
      user("a", "旧 张伟"),
      branchSummary("b", "旧摘要 13812345678"),
      custom("k", "保留自定义 张伟 呀"),
      branchSummary("l", "保留分支摘要 13812345678 呀"),
      compaction("c", "摘要 zhangwei@acme-corp.cn", "k"),
      branchSummary("d", "压缩后分支摘要 13812345678"),
      custom("e", "压缩后自定义 上海市浦东新区张江路500号"),
    ];
    expect(await scanned("session_start", branch)).toEqual(
      sorted("摘要 zhangwei@acme-corp.cn", "保留自定义 张伟 呀", "保留分支摘要 13812345678 呀", "压缩后分支摘要 13812345678", "压缩后自定义 上海市浦东新区张江路500号"),
    );
  });

  test("压缩条目没有摘要字符串、条目残缺：不抛错，其余照扫", async () => {
    const branch: any[] = [null, user("a", "旧 张伟"), { type: "compaction", id: "c", firstKeptEntryId: "a" }, 7, user("d", "之后 13812345678")];
    expect(await scanned("session_start", branch)).toEqual(sorted("旧 张伟", "之后 13812345678"));
  });

  for (const ev of ["session_switch", "session_branch", "session_tree"]) {
    test(`${ev} 同样只扫会发出的部分`, async () => {
      const branch = [user("a", "旧 张伟"), user("b", "保留 13812345678"), compaction("c", "摘要 zhangwei@acme-corp.cn", "b"), user("d", "之后 上海市浦东新区张江路500号")];
      expect(await scanned(ev, branch)).toEqual(sorted("保留 13812345678", "摘要 zhangwei@acme-corp.cn", "之后 上海市浦东新区张江路500号"));
    });
  }

  test("范围外的文本没被预扫描，但真要发出去时出口照常推理并遮挡", async () => {
    const { rec } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const branch = [user("a", "旧 13812345678"), user("b", "保留"), compaction("c", "摘要", "b")];
    const { ctx } = makeCtx(branch);
    await t.emit("session_start", {}, ctx);
    await Bun.sleep(200);
    expect(rec.calls).not.toContain("旧 13812345678");
    const payload = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "旧 13812345678" }] };
    await t.emit("before_provider_request", { payload }, ctx);
    expect(rec.calls).toContain("旧 13812345678");
    expect(payload.messages[0]!.content).not.toContain("zcunxmhf");
  });
});

describe("映射恢复与计数不受预扫描范围影响", () => {
  test("压缩之前的映射条目仍被恢复与计数（loadBranch 用整条分支），session_switch 同样", async () => {
    // 进程 A：遮挡并持久化映射
    fresh();
    const a = makePi();
    piiGuard(a.pi);
    const { ctx: ctxA } = makeCtx([]);
    const payload = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "手机 13812345678 请记住" }] };
    await a.emit("before_provider_request", { payload }, ctxA);
    const ph = (payload.messages[0]!.content as string).match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    expect(a.entries.length).toBeGreaterThan(0);
    const saved = a.entries.map((e, i) => ({ type: "custom", customType: e.type, data: e.data, id: "m" + i }));

    for (const ev of ["session_start", "session_switch"]) {
      // 进程 B：映射条目在压缩之前（预扫描范围外）
      const { rec } = fresh();
      const b = makePi();
      piiGuard(b.pi);
      expect(testHooks.runtime().ph.restoreText(ph)).toBe(ph);
      const branch = [user("u1", "旧 张伟"), ...saved, user("u2", "保留"), compaction("c", "摘要", "u2"), user("u3", "之后")];
      const { ctx, notes } = makeCtx(branch);
      await b.emit(ev, {}, ctx);
      await Bun.sleep(200);
      expect(rec.calls).not.toContain("旧 张伟");
      expect((await b.emit("tool_call", { toolName: "write", input: { c: ph } }, ctx)).input).toEqual({ c: "13812345678" });
      await b.commands.get("pii")!.handler("", ctx);
      expect(notes.at(-1)!.msg).toMatch(/手机 1/);
    }
  });

  test("session_compact 仍用整条分支补写映射", async () => {
    const { rt } = fresh();
    rt.bprBudgetMs = 20;
    const t = makePi();
    piiGuard(t.pi);
    // 先让运行时认识这个值：遮挡一次
    const { ctx: ctx0 } = makeCtx([]);
    const payload = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "手机 13812345678 请记住" }] };
    await t.emit("before_provider_request", { payload }, ctx0);
    const ph = (payload.messages[0]!.content as string).match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0];
    // 另一个会话（同一运行时、persisted 为空）：占位符只出现在压缩之前的条目里，整条分支都要被 noteUsed 看到
    const other = makePi();
    piiGuard(other.pi);
    const compactionEntry = compaction("c", "摘要", "u2");
    const branch = [user("u1", `旧 ${ph}`), user("u2", "保留"), compactionEntry];
    const { ctx } = makeCtx(branch);
    await other.emit("session_compact", { compactionEntry, fromExtension: false }, ctx);
    expect(other.entries.length).toBe(1);
    expect(JSON.stringify(other.entries[0]!.data)).toContain(ph);
  });
});
