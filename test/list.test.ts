// /pii list 与快捷键：在 omp 自己的界面（ctx.ui.select）里列出本会话遮挡过的完整原值。
// 按“场景矩阵”覆盖：内容（六类中英文、同类多值、重复值、2 字中文名、特殊字符、超长值、像占位符的文本、已知值补遮）、
// 来源（用户输入、工具结果、工具调用参数、助手回复、system、子代理、网络层）、会话与状态（空会话、/new、恢复、branch/tree、压缩、
// off/on、模型不可用、阈值、多会话、无 UI、大量值）、隐私（原值不进通知/日志/对话/状态文件/会话条目）。
// 数据全部虚构；邮箱别用 example.* 域名（见 AGENTS.md 第 7 节）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piiGuard, { LIST_KEY, LIST_MAX_VALUE, testHooks } from "../src/index.ts";
import { Masker } from "../src/mask.ts";
import { PH_RE } from "../src/placeholder.ts";
import { FakeRecognizer } from "./fake.ts";

type Handler = (event: any, ctx: any) => any;

/** 测试里的虚构值：键是原文，值是假识别器给的标签。 */
const V = {
  zhName: "周凯文",
  zhName2: "韩梅", // 2 字中文名
  enName: "Maria Lindqvist",
  zhAddr: "上海市浦东新区世纪大道100号",
  enAddr: "221B Baker Street, London NW1 6XE",
  zhPhone: "13800138000",
  enPhone: "+1 415 555 0134",
  zhMail: "kaiwen.zhou@mailbox.cc",
  enMail: "maria.lindqvist@lindqvist-studio.io",
  card: "6222021234567890123",
  iban: "DE89370400440532013000",
  zhPwd: "kP9#xV2$mQ7!zL4w",
  enKey: "sk_live_51Hx9aBcD3fGhJk2L",
} as const;
const LABELS: Record<string, string> = {
  [V.zhName]: "private_person",
  [V.zhName2]: "private_person",
  [V.enName]: "private_person",
  [V.zhAddr]: "private_address",
  [V.enAddr]: "private_address",
  [V.zhPhone]: "phone",
  [V.enPhone]: "phone",
  [V.zhMail]: "email",
  [V.enMail]: "email",
  [V.card]: "account",
  [V.iban]: "account",
  [V.zhPwd]: "common_secret",
  [V.enKey]: "common_secret",
};
const ALL_TEXT = `我叫${V.zhName}，朋友${V.zhName2}，英文名 ${V.enName}。住在${V.zhAddr}，也有地址 ${V.enAddr}。手机 ${V.zhPhone}，海外电话 ${V.enPhone}。邮箱 ${V.zhMail}、${V.enMail}。银行卡号 ${V.card}，IBAN 账号 ${V.iban}。密码是 ${V.zhPwd}，API key: ${V.enKey}`;

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const entries: { type: string; data: any }[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => Promise<void> | void }>();
  const debug: string[] = [];
  const conflicts = new Map<string, unknown>();
  const sent: unknown[] = [];
  const pi = {
    setLabel() {},
    on(ev: string, h: Handler) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
    },
    registerCommand(name: string, o: any) {
      commands.set(name, o);
    },
    registerShortcut(key: string, o: any) {
      shortcuts.set(key, o);
    },
    getShortcutConflict: (key: string) => conflicts.get(key),
    registerAssistantTextRenderer() {},
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
    // 列表绝不能把原值写进对话：这两个一被调用就记下来，用例里断言为空
    sendMessage: (m: unknown) => void sent.push(m),
    sendUserMessage: (m: unknown) => void sent.push(m),
    logger: { debug: (m: string) => void debug.push(String(m)) },
  };
  const emit = async (ev: string, event: any, ctx: any) => {
    let last: any;
    for (const h of handlers.get(ev) ?? []) last = await h(event, ctx);
    return last;
  };
  const list = (ctx: any) => commands.get("pii")!.handler("list", ctx);
  return { pi, entries, commands, shortcuts, debug, conflicts, sent, emit, list };
}
type T = ReturnType<typeof makePi>;

interface Shown {
  title: string;
  options: string[];
}
type Answer = (options: string[]) => string | undefined;

function makeCtx(over: Record<string, any> = {}) {
  const notes: { msg: string; level: string }[] = [];
  const shown: Shown[] = [];
  const answers: Answer[] = [];
  const branch: any[] = over.branch ?? [];
  const ctx = {
    model: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    hasUI: true,
    ui: {
      notify: (msg: string, level: string) => notes.push({ msg, level }),
      select: async (title: string, options: string[]) => {
        shown.push({ title, options: [...options] });
        return answers.shift()?.(options);
      },
    },
    sessionManager: { getBranch: () => branch },
    setTimeout: (fn: () => unknown, ms: number) => setTimeout(() => void Promise.resolve(fn()).catch(() => {}), ms),
    ...over,
  };
  return { ctx, notes, shown, answers, branch };
}

const body = (content: unknown, extra: Record<string, unknown> = {}) => ({ model: "claude", max_tokens: 10, messages: [{ role: "user", content }], ...extra });
const userText = (text: string) => body(text);
const toolResult = (text: string) => body([{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text }] }]);

let dir: string;
let ternDir: string;
const savedEnv = { ...process.env };

function fresh(values: Record<string, string> = LABELS) {
  testHooks.reset();
  const rt = testHooks.runtime();
  const rec = new FakeRecognizer(values);
  rt.masker = new Masker(async () => rec, rt.ph, () => rt.config);
  rt.guard = rec as unknown as typeof rt.guard;
  rt.guardP = Promise.resolve(rec) as unknown as typeof rt.guardP;
  if (rt.tern) rt.tern.delayMs = 10;
  return { rt, rec };
}

/** 发一个请求给出口处理器，返回遮挡后的整体 JSON 文本。 */
async function send(t: T, ctx: unknown, payload: unknown): Promise<string> {
  const r = await t.emit("before_provider_request", { payload }, ctx);
  expect(r).toBeUndefined();
  return JSON.stringify(payload);
}

/** 列表里的一行拆回各列：类别 · 原值 · 占位符 · 分数（原值里可能含 " · "，所以占位符与分数从右边取）。 */
function parse(label: string) {
  const m = /^(\S+) · ([\s\S]*) · (\{\{[A-Z]+_[a-z2-7]+\}\}) · (\d\.\d\d)$/.exec(label);
  if (!m) throw new Error(`列表行格式不对：${label}`);
  return { kind: m[1]!, value: m[2]!, ph: m[3]!, score: m[4]! };
}

/** 打开列表并立刻关闭（Esc），返回弹出的那一层。 */
async function openList(t: T, ctx: any, shown: Shown[], via: "cmd" | "key" = "cmd"): Promise<Shown | undefined> {
  const before = shown.length;
  if (via === "cmd") await t.list(ctx);
  else await t.shortcuts.get(LIST_KEY)!.handler(ctx);
  return shown.length > before ? shown[before] : undefined;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-list-"));
  ternDir = path.join(dir, "tern");
  process.env.PII_GUARD_DIR = dir;
  delete process.env.TERN_PANE;
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

describe("基本：内容与格式", () => {
  test("六类中英文各一例：按类别分组（人名、地址、手机、邮箱、账号、密码），带中文类别、完整原值、占位符、分数", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const masked = await send(t, ctx, userText(ALL_TEXT));
    for (const v of Object.values(V)) expect(masked).not.toContain(v); // 请求里一个原值都不剩
    const top = (await openList(t, ctx, shown))!;
    const rows = top.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual(Object.values(V).sort());
    // 分组顺序：PERSON、ADDRESS、PHONE、EMAIL、ACCOUNT、SECRET（ALL_KINDS 的顺序）
    const order = ["人名", "地址", "手机", "邮箱", "账号", "密码"];
    const idx = rows.map((r) => order.indexOf(r.kind));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    // 每行的占位符确实出现在遮挡后的请求里，分数两位小数
    for (const r of rows) {
      expect(masked).toContain(r.ph);
      expect(r.score).toBe("0.99");
    }
    expect(top.title).toContain(`${rows.length} 个`);
    // 同类按首次出现顺序：中文名在英文名前，中文手机在海外手机前
    const at = (v: string) => rows.findIndex((r) => r.value === v);
    expect(at(V.zhName)).toBeLessThan(at(V.zhName2));
    expect(at(V.zhName2)).toBeLessThan(at(V.enName));
    expect(at(V.zhPhone)).toBeLessThan(at(V.enPhone));
    expect(at(V.zhMail)).toBeLessThan(at(V.enMail));
  });

  test("列表条数与 /pii 的各类计数同源（同一份 used）", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes } = makeCtx();
    await send(t, ctx, userText(ALL_TEXT));
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    await t.commands.get("pii")!.handler("", ctx);
    const summary = notes.at(-1)!.msg;
    for (const [kind, zh] of [["PERSON", "人名"], ["ADDRESS", "地址"], ["PHONE", "手机"], ["EMAIL", "邮箱"], ["ACCOUNT", "账号"], ["SECRET", "密码"]] as const) {
      const n = rows.filter((r) => r.kind === zh).length;
      expect(summary).toContain(`${zh} ${n}`);
      expect(rows.filter((r) => r.ph.startsWith(`{{${kind}_`)).length).toBe(n);
    }
  });

  test("同一值多次出现（同一请求内、多条消息、多次请求）：只列一次，占位符相同", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const p = body("手机 13800138000，再说一遍手机 13800138000", { system: [{ type: "text", text: "联系手机 13800138000" }] });
    (p.messages as any[]).push({ role: "assistant", content: "收到手机 13800138000" }, { role: "user", content: "手机 13800138000" });
    const masked = await send(t, ctx, p);
    await send(t, ctx, userText("第二次请求，手机 13800138000"));
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.length).toBe(1);
    expect(rows[0]!.value).toBe("13800138000");
    const phs = [...masked.matchAll(PH_RE)].map((m) => m[0]);
    expect(new Set(phs)).toEqual(new Set([rows[0]!.ph]));
  });

  test("同类多个值（5 个手机号）：各占一行，顺序为首次出现的顺序", async () => {
    const phones = ["13800138001", "13900139002", "13700137003", "13600136004", "13500135005"];
    fresh(Object.fromEntries(phones.map((p) => [p, "phone"])));
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    await send(t, ctx, userText(`依次是 手机 ${phones[2]}、手机 ${phones[0]}、手机 ${phones[4]}、手机 ${phones[1]}、手机 ${phones[3]}`));
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual([phones[2], phones[0], phones[4], phones[1], phones[3]]);
  });

  test("2 字中文名也能列出（且不与更长的名字合并）", async () => {
    fresh({ 韩梅: "private_person", 李雷: "private_person" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const masked = await send(t, ctx, userText("同事韩梅和同学李雷一起去了"));
    expect(masked).not.toContain("韩梅");
    expect(masked).not.toContain("李雷");
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual(["韩梅", "李雷"]);
  });

  test("特殊字符的值：emoji/代理对、| 、引号、反斜杠、换行、{{ }}、制表符都列出且一行一项；全文里换行保留、控制字符显示为可见符号", async () => {
    const odd = {
      pipe: "Zoë \"Zed\" O'Brien 😀🎉",
      braces: "pw{{a}}b}}c{{d",
      nl: "第一行地址\n第二行 | 地址 \t制表",
      esc: "token\u001b[31mred\u001b[0m\u0007",
    };
    fresh({ [odd.pipe]: "private_person", [odd.braces]: "common_secret", [odd.nl]: "private_address", [odd.esc]: "common_secret" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, answers } = makeCtx();
    await send(t, ctx, userText(`名字是 ${odd.pipe}；密码是 ${odd.braces}；地址 ${odd.nl}；令牌 ${odd.esc}`));
    answers.push((o) => o[0], () => undefined, () => undefined);
    const top = (await openList(t, ctx, shown))!;
    expect(top.options.length).toBe(4);
    for (const o of top.options) {
      expect(o).not.toMatch(/[\n\u001b\u0007\t]/); // 一行一项：没有换行、制表、ESC、BEL
      parse(o);
    }
    expect(new Set(top.options).size).toBe(4);
    const row = (kind: string) => top.options.find((o) => o.startsWith(`${kind} · `))!;
    expect(parse(row("人名")).value).toBe(odd.pipe); // 含 " · " 与引号也能完整取回
    // 选中第一项（人名）：第二层标题里有完整原值
    const detail = shown[1]!;
    expect(detail.title).toContain(odd.pipe);
    expect(detail.options).toEqual(["返回列表"]);
    // 换行与制表保留在全文里；ESC/BEL 不会原样出现在任何显示文本里
    const all = shown.flatMap((s) => [s.title, ...s.options]).join("\n");
    expect(all).not.toMatch(/[\u001b\u0007]/);
  });

  test("含换行与控制字符的值：选中后全文标题保留换行/制表，ESC/BEL 换成可见符号", async () => {
    const nl = "第一行地址\n第二行地址\t制表";
    const esc = "token\u001b[31mred\u0007";
    fresh({ [nl]: "private_address", [esc]: "common_secret" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, answers } = makeCtx();
    await send(t, ctx, userText(`地址 ${nl}；令牌 ${esc}`));
    const pick = (zh: string): Answer => (o) => o.find((x) => x.startsWith(`${zh} · `));
    answers.push(pick("地址"), () => undefined, pick("密码"), () => undefined, () => undefined);
    await t.list(ctx);
    const addrDetail = shown[1]!.title;
    expect(addrDetail).toContain(nl); // 换行与制表原样保留
    const pwdDetail = shown[3]!.title;
    expect(pwdDetail).not.toMatch(/[\u001b\u0007]/);
    expect(pwdDetail).toContain("\u241b"); // ESC → ␛
    expect(pwdDetail).toContain("\u2407"); // BEL → ␇
  });

  test("超长值（超过 LIST_MAX_VALUE 字符）：列表里截断并带 …，选中后第二层标题里是完整原值，返回后可继续选别的；两个长值前缀相同也各自对应", async () => {
    const prefix = "上海市浦东新区世纪大道100号环球金融中心塔楼三十二层西侧靠近电梯厅的第三个玻璃隔断办公室旁边的消防通道出口处的储物柜编号，该储物柜位于地下二层停车场东北角的员工专用通道尽头靠墙一侧";
    const a = `${prefix}A-1001`;
    const b = `${prefix}B-2002`;
    expect([...prefix].length).toBeGreaterThan(LIST_MAX_VALUE);
    fresh({ [a]: "private_address", [b]: "private_address" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, answers } = makeCtx();
    await send(t, ctx, userText(`地址一 ${a}，地址二 ${b}`));
    // 选第二项 → 返回列表 → 选第一项 → 返回 → Esc
    answers.push((o) => o[1], () => "返回列表", (o) => o[0], () => "返回列表", () => undefined);
    await t.list(ctx);
    expect(shown.length).toBe(5);
    const top = shown[0]!;
    expect(top.options.length).toBe(2);
    for (const o of top.options) {
      expect(o).toContain("…");
      expect(o).not.toContain("A-1001");
      expect(o).not.toContain("B-2002");
      expect(parse(o).value.length).toBeLessThanOrEqual(LIST_MAX_VALUE + 1);
    }
    expect(new Set(top.options).size).toBe(2); // 占位符不同，所以行不同
    expect(shown[1]!.title).toContain(b);
    expect(shown[1]!.title).not.toContain(a);
    expect(shown[3]!.title).toContain(a);
    expect(shown[2]!.options).toEqual(top.options); // 返回后的列表与之前一致
  });

  test("恰好 LIST_MAX_VALUE 字符的值不截断；多一个字符的截断", async () => {
    const v80 = "地".repeat(LIST_MAX_VALUE);
    const v81 = "址".repeat(LIST_MAX_VALUE + 1);
    fresh({ [v80]: "private_address", [v81]: "private_address" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    await send(t, ctx, userText(`地址 ${v80}，地址 ${v81}`));
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.find((r) => r.value === v80)).toBeDefined();
    expect(rows.find((r) => r.value.startsWith("址"))!.value).toBe(`${"址".repeat(LIST_MAX_VALUE)}…`);
  });

  test("像占位符的文本与 omp 的 $$…$$：不是遮挡值，不列出；真正遮挡的照常列出", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    // 映射里没有的 {{PHONE_abcdefgh}}、omp Hide Secrets 的 $$…$$（本地没有字面出现 → omp 生成的，受保护）
    const masked = await send(t, ctx, userText("字面写的 {{PHONE_abcdefgh}}，omp 的 $$ABCD1234EFGH:L$$，手机 13800138000"));
    expect(masked).toContain("{{PHONE_abcdefgh}}");
    expect(masked).toContain("$$ABCD1234EFGH:L$$");
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual(["13800138000"]);
    expect(shown[0]!.options.join("\n")).not.toContain("abcdefgh");
    expect(shown[0]!.options.join("\n")).not.toContain("ABCD1234EFGH");
  });

  test("只有像占位符的文本、没有真遮挡：按空会话处理", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes } = makeCtx();
    await send(t, ctx, userText("字面写的 {{PHONE_abcdefgh}} 和 $$ABCD1234EFGH:L$$"));
    expect(await openList(t, ctx, shown)).toBeUndefined();
    expect(notes.at(-1)).toEqual({ msg: "本会话还没有遮挡任何值", level: "info" });
  });

  test("已知值补遮：模型这次没给区间、靠已知值表遮住的值，在新会话里照样列出（且只一行）", async () => {
    const { rt, rec } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const a = makeCtx();
    await send(t, a.ctx, userText(`我叫${V.zhName}，手机 ${V.zhPhone}`));
    // 新会话（/new）：used 清空；模型这次什么也认不出，只有已知值补遮
    rec.values = {};
    const b = makeCtx({ branch: [] });
    await t.emit("session_switch", { reason: "new" }, b.ctx);
    expect(await openList(t, b.ctx, b.shown)).toBeUndefined(); // /new 后还没有遮挡
    const masked = await send(t, b.ctx, userText(`再提一次${V.zhName}，他的手机 ${V.zhPhone}`));
    expect(masked).not.toContain(V.zhName);
    expect(masked).not.toContain(V.zhPhone);
    expect(rec.calls.length).toBeGreaterThan(0);
    const rows = (await openList(t, b.ctx, b.shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual([V.zhName, V.zhPhone].sort());
    expect(rt.ph.known.size).toBeGreaterThan(0);
  });
});

describe("来源", () => {
  test("工具结果：.env、日志、JSON、CSV、代码注释里的值", async () => {
    const vals = {
      envKey: "sk_live_51Hx9aBcD3fGhJk2L",
      logMail: "ops.lead@northwind-labs.io",
      jsonPhone: "13912345678",
      csvName: "周凯文",
      csvAddr: "上海市浦东新区世纪大道100号",
      comment: "Maria Lindqvist",
    };
    fresh({ [vals.envKey]: "common_secret", [vals.logMail]: "email", [vals.jsonPhone]: "phone", [vals.csvName]: "private_person", [vals.csvAddr]: "private_address", [vals.comment]: "private_person" });
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const text = [
      `# .env\nSTRIPE_API_KEY=${vals.envKey}`,
      `2026-11-11 10:00:01 INFO sent receipt to ${vals.logMail}`,
      `{"user": {"mobile": "${vals.jsonPhone}"}}`,
      `name,address\n${vals.csvName},${vals.csvAddr}`,
      `// TODO: ask ${vals.comment} about the migration`,
    ].join("\n");
    const masked = await send(t, ctx, toolResult(text));
    for (const v of Object.values(vals)) expect(masked).not.toContain(v);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual(Object.values(vals).sort());
  });

  test("工具调用参数（历史里 assistant 的 tool_use 输入）里的值", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const p = body("写文件");
    (p.messages as any[]).push({ role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "write", input: { path: "/tmp/a.txt", content: `联系人 ${V.zhName}，邮箱 ${V.zhMail}` } }] });
    const masked = await send(t, ctx, p);
    expect(masked).not.toContain(V.zhName);
    expect(masked).not.toContain(V.zhMail);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual([V.zhName, V.zhMail].sort());
  });

  test("助手回复：历史里 assistant 文本的原值被遮挡并列出；回复里的占位符被还原但不重复列出", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const first = await send(t, ctx, userText(`手机 ${V.zhPhone}`));
    const ph = first.match(PH_RE)![0]!;
    // 助手回复里引用占位符 → assistant_message 还原成原值（显示给用户）
    const r = await t.emit("assistant_message", { message: { content: [{ type: "text", text: `已记录 ${ph}` }] } }, ctx);
    expect(r.content[0].text).toBe(`已记录 ${V.zhPhone}`);
    // 下一次请求：历史里的助手文本已是还原后的原值 → 再次被遮挡（同一占位符）
    const p = body(`手机 ${V.zhPhone}`);
    (p.messages as any[]).unshift({ role: "assistant", content: [{ type: "text", text: `已记录 ${V.zhPhone}，另有邮箱 ${V.zhMail}` }] });
    await send(t, ctx, p);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual([V.zhMail, V.zhPhone].sort());
    expect(rows.find((x) => x.value === V.zhPhone)!.ph).toBe(ph);
  });

  test("system 提示 / AGENTS.md 类上下文里的值（string 与数组两种 system）", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    await send(t, ctx, body("hi", { system: `# AGENTS.md\n维护人 ${V.enName}，电话 ${V.enPhone}` }));
    await send(t, ctx, body("hi", { system: [{ type: "text", text: `上下文文件：邮箱 ${V.zhMail}` }] }));
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual([V.enName, V.enPhone, V.zhMail].sort());
  });

  test("openai-responses / codex 格式的请求：同样列出（function_call 参数、input 文本）", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    for (const api of ["openai-responses", "openai-codex-responses"]) {
      const { ctx, shown } = makeCtx({ model: { api, baseUrl: "https://chatgpt.com/backend-api" } });
      const payload = { model: "m", input: [{ role: "user", content: [{ type: "input_text", text: `手机 ${V.zhPhone}` }] }, { type: "function_call", call_id: "c", name: "write", arguments: JSON.stringify({ content: `邮箱 ${V.zhMail}` }) }] };
      await send(t, ctx, payload);
      const rows = (await openList(t, ctx, shown))!.options.map(parse);
      expect(rows.map((r) => r.value).sort()).toEqual([V.zhMail, V.zhPhone].sort());
      testHooks.runtime().ph; // 同进程共享；下一轮同值同占位符
    }
  });

  test("子代理会话：自己的 used 不进主会话列表；子代理里 /pii list 与快捷键不弹界面也不输出原值；主会话照常", async () => {
    fresh();
    const main = makePi();
    piiGuard(main.pi);
    const sub = makePi();
    piiGuard(sub.pi);
    const m = makeCtx();
    const s = makeCtx({ agent: { kind: "sub" }, hasUI: false });
    await send(sub, s.ctx, userText(`子代理读到 ${V.zhPhone}`));
    await send(main, m.ctx, userText(`主会话读到 ${V.zhMail}`));
    // 子代理：没有界面，调用只静默返回
    await sub.list(s.ctx);
    await sub.shortcuts.get(LIST_KEY)!.handler(s.ctx);
    expect(s.shown.length).toBe(0);
    expect(s.notes.map((n) => n.msg).join("")).not.toContain(V.zhPhone);
    // 主会话：只有自己请求里的值（子代理的值计在子代理自己的会话里，与 /pii 计数口径一致）
    const rows = (await openList(main, m.ctx, m.shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual([V.zhMail]);
  });

  test("网络层路径（标题生成、压缩的直连请求）遮挡的值：不经出口处理器，不计入；压缩保存后摘要里的占位符计入并列出", async () => {
    const { rt } = fresh();
    rt.bprBudgetMs = 20;
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes, branch } = makeCtx();
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.text());
        return new Response("ok");
      },
    });
    try {
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(userText(`标题请求，手机 ${V.zhPhone}`)) });
    } finally {
      server.stop(true);
    }
    expect(received[0]).not.toContain(V.zhPhone); // 网络层遮住了
    const ph = received[0]!.match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0]!;
    // 与 /pii 一致：网络层单独遮挡的不计入“本会话已遮挡”
    expect(await openList(t, ctx, shown)).toBeUndefined();
    expect(notes.at(-1)!.msg).toBe("本会话还没有遮挡任何值");
    // 压缩：摘要里引用了这个占位符 → session_compact 计入
    const compactionEntry = { type: "compaction", id: "c1", summary: `用户手机 ${ph}` };
    branch.push(compactionEntry);
    await t.emit("session_compact", { compactionEntry, fromExtension: false }, ctx);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual([V.zhPhone]);
    expect(rows[0]!.ph).toBe(ph);
  });
});

describe("会话与状态", () => {
  test("空会话：提示“本会话还没有遮挡任何值”，不弹层", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes } = makeCtx();
    expect(await openList(t, ctx, shown)).toBeUndefined();
    expect(await openList(t, ctx, shown, "key")).toBeUndefined();
    expect(notes.map((n) => n.msg)).toEqual(["本会话还没有遮挡任何值", "本会话还没有遮挡任何值"]);
  });

  test("快捷键：用 LIST_KEY 注册，处理函数打开的是同一个列表；命令描述提到 /pii list", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    expect(t.shortcuts.has(LIST_KEY)).toBe(true);
    expect(t.shortcuts.get(LIST_KEY)!.description).toContain("遮挡");
    expect(t.commands.get("pii")).toBeDefined();
    const { ctx, shown } = makeCtx();
    await send(t, ctx, userText(`手机 ${V.zhPhone}`));
    const viaCmd = (await openList(t, ctx, shown, "cmd"))!;
    const viaKey = (await openList(t, ctx, shown, "key"))!;
    expect(viaKey).toEqual(viaCmd);
    // 命令描述与用法提示都带上 list
    let desc = "";
    const t2 = makePi();
    const orig = t2.pi.registerCommand;
    t2.pi.registerCommand = (n: string, o: any) => {
      desc = o.description;
      orig(n, o);
    };
    piiGuard(t2.pi);
    expect(desc).toContain("/pii list");
    await t2.commands.get("pii")!.handler("bogus", ctx);
  });

  test("列表已打开时再次触发（快捷键重复按、命令再执行）：不叠加第二层", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    await send(t, ctx, userText(`手机 ${V.zhPhone}`));
    const gate = Promise.withResolvers<string | undefined>();
    ctx.ui.select = async (title: string, options: string[]) => {
      shown.push({ title, options: [...options] });
      return gate.promise;
    };
    const first = t.list(ctx);
    await Bun.sleep(0);
    await t.shortcuts.get(LIST_KEY)!.handler(ctx); // 已有一层：直接返回
    await t.list(ctx);
    expect(shown.length).toBe(1);
    gate.resolve(undefined);
    await first;
    // 关闭后可再次打开
    ctx.ui.select = async (title: string, options: string[]) => {
      shown.push({ title, options: [...options] });
      return undefined;
    };
    await t.list(ctx);
    expect(shown.length).toBe(2);
  });

  test("/new（session_switch 到空会话）：列表为空；之前会话的值不串过来；再切回旧会话恢复", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const a = makeCtx();
    await t.emit("session_start", {}, a.ctx);
    await send(t, a.ctx, userText(`手机 ${V.zhPhone}`));
    const saved = t.entries.map((x, i) => ({ type: "custom", customType: x.type, data: x.data, id: String(i) }));
    const empty = makeCtx({ branch: [] });
    await t.emit("session_switch", { reason: "new" }, empty.ctx);
    expect(await openList(t, empty.ctx, empty.shown)).toBeUndefined();
    expect(empty.notes.at(-1)!.msg).toBe("本会话还没有遮挡任何值");
    const back = makeCtx({ branch: saved });
    await t.emit("session_switch", { reason: "resume" }, back.ctx);
    const rows = (await openList(t, back.ctx, back.shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual([V.zhPhone]);
  });

  test("恢复旧会话（新进程）：从会话分支里的映射条目重建，值与分数都在；类别分组", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await send(t, ctx, userText(ALL_TEXT));
    const saved = t.entries.map((x, i) => ({ type: "custom", customType: x.type, data: x.data, id: String(i) }));
    testHooks.reset(); // 新进程：占位符表为空
    fresh({});
    const b = makePi();
    piiGuard(b.pi);
    const rb = makeCtx({ branch: saved });
    await b.emit("session_start", {}, rb.ctx);
    const rows = (await openList(b, rb.ctx, rb.shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual(Object.values(V).sort());
    expect(rows.every((r) => r.score === "0.99")).toBe(true);
  });

  test("branch / tree：切到较短的分支只列该分支里的值；切回长分支恢复", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const a = makeCtx();
    await send(t, a.ctx, userText(`第一轮 手机 ${V.zhPhone}`));
    const mark1 = t.entries.length;
    await send(t, a.ctx, userText(`第二轮 邮箱 ${V.zhMail}`));
    const all = t.entries.map((x, i) => ({ type: "custom", customType: x.type, data: x.data, id: String(i) }));
    const short = makeCtx({ branch: all.slice(0, mark1) });
    for (const ev of ["session_branch", "session_tree"] as const) {
      await t.emit(ev, {}, short.ctx);
      const rows = (await openList(t, short.ctx, short.shown))!.options.map(parse);
      expect(rows.map((r) => r.value)).toEqual([V.zhPhone]);
      const full = makeCtx({ branch: all });
      await t.emit(ev, {}, full.ctx);
      const rows2 = (await openList(t, full.ctx, full.shown))!.options.map(parse);
      expect(rows2.map((r) => r.value).sort()).toEqual([V.zhMail, V.zhPhone].sort());
    }
  });

  test("压缩后（session_compact）：摘要里的占位符计入；分支里已有的映射不丢", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, branch } = makeCtx();
    const masked = await send(t, ctx, userText(`手机 ${V.zhPhone}，邮箱 ${V.zhMail}`));
    const [phone, mail] = [masked.match(/\{\{PHONE_[a-z2-7]{8}\}\}/)![0]!, masked.match(/\{\{EMAIL_[a-z2-7]{8}\}\}/)![0]!];
    const compactionEntry = { type: "compaction", id: "c1", summary: `摘要：用户手机 ${phone}、邮箱 ${mail}` };
    branch.push(compactionEntry);
    await t.emit("session_compact", { compactionEntry, fromExtension: false }, ctx);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual([V.zhMail, V.zhPhone].sort());
  });

  test("/pii off 后再 on：关闭期间请求原样发出（不新增值），已列出的仍可看；重新开启后继续累计", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    await send(t, ctx, userText(`手机 ${V.zhPhone}`));
    await t.commands.get("pii")!.handler("off", ctx);
    const raw = await send(t, ctx, userText(`关闭期间 邮箱 ${V.zhMail}`)); // 出口：关闭时原样放行
    expect(raw).toContain(V.zhMail);
    let rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual([V.zhPhone]);
    await t.commands.get("pii")!.handler("on", ctx);
    await send(t, ctx, userText(`重新开启 邮箱 ${V.zhMail}`));
    rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value).sort()).toEqual([V.zhMail, V.zhPhone].sort());
  });

  test("OMP_PII_GUARD=off：没有遮挡也没有计数，/pii list 提示空；不会因此报错", async () => {
    process.env.OMP_PII_GUARD = "off";
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes } = makeCtx();
    expect(await openList(t, ctx, shown)).toBeUndefined();
    expect(notes.at(-1)!.msg).toBe("本会话还没有遮挡任何值");
  });

  test("模型不可用：请求被阻止（不发出），此前已遮挡的值仍可查看；没有值时仍是空提示", async () => {
    const { rec } = fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes } = makeCtx();
    await send(t, ctx, userText(`手机 ${V.zhPhone}`));
    rec.failWith = new Error("模型文件不可用");
    // 新文本（避开遮挡缓存）→ 识别失败 → return {}，请求不发出
    const r = await t.emit("before_provider_request", { payload: userText(`新的 邮箱 ${V.zhMail}`) }, ctx);
    expect(r).toEqual({});
    expect(notes.some((n) => n.level === "error")).toBe(true);
    expect(notes.map((n) => n.msg).join("\n")).not.toContain(V.zhMail);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r2) => r2.value)).toEqual([V.zhPhone]); // 失败的请求没有产生新值，旧值仍在
  });

  test("调高 threshold 后：列表里的分数照实显示；此前遮挡的值仍列出，之后低于新阈值的值不再被遮挡（与 /pii 计数一致）", async () => {
    const { rt } = fresh({});
    class ScoreRec extends FakeRecognizer {
      override async find(text: string) {
        const out = await super.find(text);
        return out.map((f) => ({ ...f, score: text.slice(f.start, f.end) === V.zhPhone ? 0.85 : 0.97 }));
      }
    }
    const rec = new ScoreRec({ [V.zhPhone]: "phone", [V.zhMail]: "email" });
    rt.masker = new Masker(async () => rec, rt.ph, () => rt.config);
    rt.config.threshold = 0.8;
    rt.masker.configChanged();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes } = makeCtx();
    await send(t, ctx, userText(`手机 ${V.zhPhone}，邮箱 ${V.zhMail}`));
    let rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(Object.fromEntries(rows.map((r) => [r.value, r.score]))).toEqual({ [V.zhPhone]: "0.85", [V.zhMail]: "0.97" });
    // 调高阈值：0.85 的手机不再被识别为遮挡对象；已列出的不被删掉
    rt.config.threshold = 0.9;
    rt.masker.configChanged();
    const out = await send(t, ctx, userText(`另一段 手机 ${V.zhPhone} 还有邮箱 ${V.zhMail}`));
    expect(out).toContain(V.zhPhone); // 低于阈值：原样（已知值表也按阈值过滤）
    expect(out).not.toContain(V.zhMail);
    rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.length).toBe(2);
    await t.commands.get("pii")!.handler("", ctx);
    expect(notes.at(-1)!.msg).toContain("手机 1");
    expect(notes.at(-1)!.msg).toContain("邮箱 1");
  });

  test("只遮部分类别（config.kinds）：只列被遮的类别", async () => {
    const { rt } = fresh();
    rt.config.kinds = new Set(["PHONE"]);
    rt.masker.configChanged();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const out = await send(t, ctx, userText(`我叫${V.zhName}，手机 ${V.zhPhone}`));
    expect(out).toContain(V.zhName);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.kind)).toEqual(["手机"]);
  });

  test("allow 词：配置放行的值不遮挡也不列出", async () => {
    const { rt } = fresh();
    rt.config.allow = new Set(["maria lindqvist"]);
    rt.masker.configChanged();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown } = makeCtx();
    const out = await send(t, ctx, userText(`我叫${V.enName}，手机 ${V.zhPhone}`));
    expect(out).toContain(V.enName);
    const rows = (await openList(t, ctx, shown))!.options.map(parse);
    expect(rows.map((r) => r.value)).toEqual([V.zhPhone]);
  });

  test("同进程多个会话（工厂各跑一次）：各自的列表只含自己请求里的值，同值同占位符", async () => {
    fresh();
    const a = makePi();
    piiGuard(a.pi);
    const b = makePi();
    piiGuard(b.pi);
    const ca = makeCtx();
    const cb = makeCtx();
    await send(a, ca.ctx, userText(`甲 手机 ${V.zhPhone}，邮箱 ${V.zhMail}`));
    await send(b, cb.ctx, userText(`乙 手机 ${V.zhPhone}，英文名 ${V.enName}`));
    const ra = (await openList(a, ca.ctx, ca.shown))!.options.map(parse);
    const rb = (await openList(b, cb.ctx, cb.shown))!.options.map(parse);
    expect(ra.map((r) => r.value).sort()).toEqual([V.zhMail, V.zhPhone].sort());
    expect(rb.map((r) => r.value).sort()).toEqual([V.enName, V.zhPhone].sort());
    expect(ra.find((r) => r.value === V.zhPhone)!.ph).toBe(rb.find((r) => r.value === V.zhPhone)!.ph);
  });

  test("大量值（250 个手机号）：一次弹出、全部在列、占位符互不相同；每行仍可对应回原值", async () => {
    const phones = Array.from({ length: 250 }, (_, i) => `139${String(10000000 + i * 7919).slice(0, 8)}`);
    expect(new Set(phones).size).toBe(250);
    fresh(Object.fromEntries(phones.map((p) => [p, "phone"])));
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, answers } = makeCtx();
    await send(t, ctx, userText(phones.map((p, i) => `联系人${i} 手机 ${p}`).join("\n")));
    const t0 = performance.now();
    answers.push((o) => o[199], () => undefined, () => undefined);
    await t.list(ctx);
    const ms = performance.now() - t0;
    if (process.env.PII_LIST_PERF) console.log(`[perf] /pii list 250 个值，含一次选中：${ms.toFixed(1)} ms`);
    expect(shown[0]!.options.length).toBe(250);
    expect(new Set(shown[0]!.options.map((o) => parse(o).ph)).size).toBe(250);
    expect(shown[0]!.options.map((o) => parse(o).value)).toEqual(phones);
    expect(shown[1]!.title).toContain(phones[199]!);
  });
});

describe("无界面与隐私", () => {
  test("无 UI（-p、无界面 RPC）：/pii list 与快捷键只提示需要交互界面，不弹层、不输出原值（通知、stderr、日志）", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const withUi = makeCtx();
    await send(t, withUi.ctx, userText(ALL_TEXT)); // 先有值
    const noUi = makeCtx({ hasUI: false });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      await t.list(noUi.ctx);
      await t.shortcuts.get(LIST_KEY)!.handler(noUi.ctx);
    } finally {
      console.error = orig;
    }
    expect(noUi.shown.length).toBe(0);
    expect(noUi.notes.length).toBe(0); // 无界面时通知不会显示，提示走 stderr
    expect(errs.length).toBe(2);
    for (const e of errs) expect(e).toBe("[pii-guard] /pii list 需要交互界面（原值只在本机 omp 界面显示）");
    const everything = [...noUi.notes.map((n) => n.msg), ...errs, ...t.debug].join("\n");
    for (const v of Object.values(V)) expect(everything).not.toContain(v);
  });

  test("隐私：打开、选中、关闭列表不写对话/会话条目/日志，通知里没有原值；弹层之外的任何地方都不出现原值", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes, answers } = makeCtx();
    await send(t, ctx, userText(ALL_TEXT));
    const entriesBefore = JSON.stringify(t.entries);
    const notesBefore = notes.length;
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      answers.push((o) => o[0], () => "返回列表", (o) => o[3], () => undefined, () => undefined);
      await t.list(ctx);
      await t.shortcuts.get(LIST_KEY)!.handler(ctx);
    } finally {
      console.error = orig;
    }
    expect(shown.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.entries)).toBe(entriesBefore); // 没有新条目
    expect(t.sent).toEqual([]); // 没有 sendMessage / sendUserMessage
    expect(notes.length).toBe(notesBefore); // 没有通知
    const outside = [...notes.map((n) => n.msg), ...errs, ...t.debug].join("\n");
    for (const v of Object.values(V)) expect(outside).not.toContain(v);
  });

  test("选择器抛错：只记一条不含原值的警告，列表状态复位（之后可再打开）", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes } = makeCtx();
    await send(t, ctx, userText(`手机 ${V.zhPhone}`));
    ctx.ui.select = async () => {
      throw new Error("渲染失败");
    };
    await t.list(ctx);
    const warn = notes.at(-1)!;
    expect(warn.level).toBe("warning");
    expect(warn.msg).toContain("打开原值列表失败");
    expect(warn.msg).not.toContain(V.zhPhone);
    ctx.ui.select = async (title: string, options: string[]) => {
      shown.push({ title, options: [...options] });
      return undefined;
    };
    await t.list(ctx);
    expect(shown.length).toBe(1);
  });

  test("快捷键被别的绑定占用：session_start 提示一次（含冲突种类，不含值）；无冲突不提示；无 UI 不检查", async () => {
    fresh();
    const t = makePi();
    t.conflicts.set(LIST_KEY, { kind: "keybinding", keybindings: ["x"] });
    piiGuard(t.pi);
    const a = makeCtx();
    await t.emit("session_start", {}, a.ctx);
    expect(a.notes.some((n) => n.level === "warning" && n.msg.includes("keybinding") && n.msg.includes("/pii list"))).toBe(true);
    // 无冲突
    testHooks.reset();
    fresh();
    const t2 = makePi();
    piiGuard(t2.pi);
    const b = makeCtx();
    await t2.emit("session_start", {}, b.ctx);
    expect(b.notes.some((n) => n.msg.includes("已被占用"))).toBe(false);
    // 无 UI
    testHooks.reset();
    fresh();
    const t3 = makePi();
    t3.conflicts.set(LIST_KEY, { kind: "reserved" });
    piiGuard(t3.pi);
    const c = makeCtx({ hasUI: false });
    await t3.emit("session_start", {}, c.ctx);
    expect(c.notes.some((n) => n.msg.includes("已被占用"))).toBe(false);
  });
});

describe("Tern 状态文件契约不变", () => {
  test("有 TERN_PANE 时：列表操作前后状态文件都只含计数，不含任何原值与占位符", async () => {
    process.env.TERN_PANE = "7";
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, answers } = makeCtx();
    await t.emit("session_start", {}, ctx);
    const masked = await send(t, ctx, userText(ALL_TEXT));
    answers.push((o) => o[0], () => undefined, () => undefined);
    await t.list(ctx);
    const rt = testHooks.runtime();
    for (let i = 0; i < 400 && rt.tern?.pending; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    const file = path.join(ternDir, "7.json");
    const text = fs.readFileSync(file, "utf8");
    const j = JSON.parse(text);
    expect(Object.keys(j).sort()).toEqual(["failed", "kinds", "level", "model", "on", "pane", "pid", "requests", "summary", "updatedAt", "v"].sort());
    expect(j.kinds).toEqual({ PERSON: 3, ADDRESS: 2, PHONE: 2, EMAIL: 2, ACCOUNT: 2, SECRET: 2 });
    for (const v of Object.values(V)) expect(text).not.toContain(v);
    expect(text).not.toMatch(PH_RE);
    for (const ph of masked.matchAll(PH_RE)) expect(text).not.toContain(ph[0]);
    expect(shown.length).toBeGreaterThan(0);
  });
});
