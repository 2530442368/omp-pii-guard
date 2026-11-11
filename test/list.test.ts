// /pii list 与快捷键：在本机 omp 的 TUI（ctx.ui.custom 组件，src/list-ui.ts）里列出本会话遮挡过的完整原值。
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
import { ValueList, columns, detailHeader, fit, listLabel, openValueList, visible, wrap, type ListItem } from "../src/list-ui.ts";
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

/** 列表组件的宽度：够宽，列表行和详情都不折行/截断（折行与截断另有专门的用例）。 */
const WIDE = 4000;
/** 假的 keybindings：tui.select.* 对应的终端按键序列。 */
const KEYS: Record<string, string> = {
  "tui.select.up": "\x1b[A",
  "tui.select.down": "\x1b[B",
  "tui.select.pageUp": "\x1b[5~",
  "tui.select.pageDown": "\x1b[6~",
  "tui.select.confirm": "\r",
  "tui.select.cancel": "\x1b",
};
const kb = { matches: (data: string, id: string) => KEYS[id] === data };
const UP = KEYS["tui.select.up"]!;
const DOWN = KEYS["tui.select.down"]!;
const ENTER = KEYS["tui.select.confirm"]!;
const ESC = KEYS["tui.select.cancel"]!;
const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

interface ListComponent {
  render(width: number): readonly string[];
  handleInput(data: string): void;
}

/** 造一个 tui（终端行数可调）和 done 记录，调 factory 得到真实的列表组件。 */
async function mountList(factory: any, over: { rows?: number; theme?: unknown } = {}) {
  const state = { closed: false, repaints: 0 };
  const tui = { terminal: { rows: over.rows ?? 30, columns: WIDE }, requestRender: () => void state.repaints++ };
  const comp = (await factory(tui, "theme" in over ? over.theme : plainTheme, kb, () => void (state.closed = true))) as ListComponent;
  return { comp, state, tui };
}

/** 列表层当前选中的行（去掉前缀 "› "）。 */
function selectedRow(frame: readonly string[]): string {
  const row = frame.find((r) => r.startsWith("› "));
  if (!row) throw new Error("没有选中行：" + frame.join(" | "));
  return row.slice(2);
}
const footerPos = (frame: readonly string[]) => /^第 (\d+)\/(\d+) 项$/.exec(frame.at(-1)!)!;

/** 逐项向下走一遍，收集列表里全部项的文本（一屏放不下时靠滚动）；走完回到第一项。 */
function collectOptions(comp: ListComponent): string[] {
  const total = Number(footerPos(comp.render(WIDE))[2]);
  for (let i = 1; i < total; i++) comp.handleInput(UP); // 从第一项起
  const first = comp.render(WIDE);
  const options = [selectedRow(first)];
  for (let i = 1; i < total; i++) {
    comp.handleInput(DOWN);
    options.push(selectedRow(comp.render(WIDE)));
  }
  for (let i = 1; i < total; i++) comp.handleInput(UP);
  return options;
}

/** 详情层：标题行 + 全部原值行（一屏放不下时逐屏滚动）；格式与旧版 select 的标题一致（第一行标题，其后是原值全文）。 */
function collectDetail(comp: ListComponent): string {
  let frame = comp.render(WIDE);
  const head = frame[0]!;
  const body = (f: readonly string[]) => f.slice(2).filter((r) => !/^第 \d+–\d+ 行 \/ 共 \d+ 行$/.test(r)).map((r) => r.slice(2));
  const lines = body(frame);
  for (let guard = 0; guard < 1000; guard++) {
    const m = /^第 (\d+)–(\d+) 行 \/ 共 (\d+) 行$/.exec(frame.at(-1)!);
    if (!m || Number(m[2]) >= Number(m[3])) break;
    for (let i = 0; i < 20; i++) comp.handleInput(DOWN);
    frame = comp.render(WIDE);
    const got = body(frame);
    const known = Number(m[2]);
    lines.push(...got.slice(Math.max(0, got.length - (Number(/^第 \d+–(\d+)/.exec(frame.at(-1)!)![1]) - known))));
  }
  return [head, ...lines].join("\n");
}

function makeCtx(over: Record<string, any> = {}) {
  const notes: { msg: string; level: string }[] = [];
  const shown: Shown[] = [];
  const answers: Answer[] = [];
  const branch: any[] = over.branch ?? [];
  /** 不走 ctx.ui.custom 的对话框原语（select、confirm、input、editor）一旦被调用就记下：它们会转发给协作访客/RPC 客户端，列表绝不能用。 */
  const forbidden: string[] = [];
  const forbid = (name: string) => async () => {
    forbidden.push(name);
    return undefined;
  };
  const ctx = {
    model: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (msg: string, level: string) => notes.push({ msg, level }),
      select: forbid("select"),
      confirm: forbid("confirm"),
      input: forbid("input"),
      editor: forbid("editor"),
      /** 像 omp 的 showHookCustom 那样：调 factory 得到组件，之后按键驱动它；按 answers 依次“选”。 */
      custom: async (factory: any) => {
        const { comp, state } = await mountList(factory);
        for (let guard = 0; guard < 200 && !state.closed; guard++) {
          const options = collectOptions(comp);
          shown.push({ title: comp.render(WIDE)[0]!, options });
          const picked = answers.shift()?.(options);
          const idx = picked === undefined ? -1 : options.indexOf(picked);
          if (idx < 0) {
            comp.handleInput(ESC); // 列表层 Esc：关闭
            continue;
          }
          for (let i = 0; i < idx; i++) comp.handleInput(DOWN);
          comp.handleInput(ENTER);
          shown.push({ title: collectDetail(comp), options: ["返回列表"] });
          answers.shift(); // 详情层的“回答”只用来保持节奏：不管给什么都回到列表
          comp.handleInput(ENTER);
        }
        expect(state.closed).toBe(true);
      },
    },
    sessionManager: { getBranch: () => branch },
    setTimeout: (fn: () => unknown, ms: number) => setTimeout(() => void Promise.resolve(fn()).catch(() => {}), ms),
    ...over,
  };
  return { ctx, notes, shown, answers, branch, forbidden };
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
    expect(addrDetail).toContain(nl.replace("\t", "    ")); // 换行保留；制表按 4 个空格显示（制表符的列宽不定，会弄乱对齐）
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
    ctx.ui.custom = async () => {
      shown.push({ title: "", options: [] });
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
    ctx.ui.custom = async () => {
      shown.push({ title: "", options: [] });
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
    for (const e of errs) expect(e).toBe("[pii-guard] /pii list 需要在 omp 交互界面里查看（原值只在本机界面显示，这里不输出）");
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
    ctx.ui.custom = async () => {
      throw new Error("渲染失败");
    };
    await t.list(ctx);
    const warn = notes.at(-1)!;
    expect(warn.level).toBe("warning");
    expect(warn.msg).toContain("打开原值列表失败");
    expect(warn.msg).not.toContain(V.zhPhone);
    ctx.ui.custom = async () => {
      shown.push({ title: "", options: [] });
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
    expect(Object.keys(j).sort()).toEqual(["failed", "kinds", "level", "list", "model", "on", "pane", "pid", "requests", "summary", "updatedAt", "v"].sort());
    expect(j.list).toBe(true); // 快捷键没有被占：插件可以发键
    expect(j.kinds).toEqual({ PERSON: 3, ADDRESS: 2, PHONE: 2, EMAIL: 2, ACCOUNT: 2, SECRET: 2 });
    for (const v of Object.values(V)) expect(text).not.toContain(v);
    expect(text).not.toMatch(PH_RE);
    for (const ph of masked.matchAll(PH_RE)) expect(text).not.toContain(ph[0]);
    expect(shown.length).toBeGreaterThan(0);
  });
});

// ---- 以下为界面组件、显示边界（RPC/协作）、快捷键占用与文本中和 ----

const item = (over: Partial<ListItem> = {}): ListItem => ({ kind: "人名", ph: "{{PERSON_aaaaaaaa}}", value: "张三丰", score: 0.99, ...over });
const env = (over: Record<string, unknown> = {}) => {
  const calls = { closed: 0, repaints: 0 };
  return {
    calls,
    env: { rows: () => 30, theme: plainTheme, kb, close: () => void calls.closed++, repaint: () => void calls.repaints++, ...over },
  };
};

describe("显示边界：只在本机 TUI，不经协作/RPC", () => {
  test("交互 TUI 里只用 ctx.ui.custom：select/confirm/input/editor 一次都没调用（它们会转发给协作访客或写进 RPC 帧）", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, shown, notes, answers, forbidden } = makeCtx();
    await send(t, ctx, userText(ALL_TEXT));
    answers.push((o) => o[0], () => undefined, () => undefined);
    await t.list(ctx);
    await t.shortcuts.get(LIST_KEY)!.handler(ctx);
    expect(shown.length).toBeGreaterThan(0);
    expect(forbidden).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("协作访客：模拟 omp 的 showCollabAwareSelector——select 的内容会转给访客；列表走 custom，访客帧里没有任何原值", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const { ctx, answers } = makeCtx();
    const guestFrames: unknown[] = [];
    const mirror = (kind: string) => async (...args: unknown[]) => {
      guestFrames.push({ kind, args }); // omp：host.requestGuestUi(request) 把 title/options 发给可写访客
      return undefined;
    };
    ctx.ui = { ...ctx.ui, select: mirror("select"), confirm: mirror("confirm"), input: mirror("input"), editor: mirror("editor") } as typeof ctx.ui;
    await send(t, ctx, userText(ALL_TEXT));
    answers.push((o) => o[0], () => undefined, () => undefined);
    await t.list(ctx);
    expect(guestFrames).toEqual([]);
    expect(JSON.stringify(guestFrames)).not.toContain(V.zhPhone);
  });

  test("RPC 客户端：模拟 rpc-mode 的 ui（dialog 与 notify 写成 extension_ui_request 帧，custom 是空操作）——命令与快捷键都不显示原值，帧里只有固定的提示", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    const frames: any[] = [];
    const rpcUi = {
      select: async (title: string, options: string[]) => void frames.push({ type: "extension_ui_request", method: "select", title, options }),
      confirm: async (title: string, message: string) => void frames.push({ type: "extension_ui_request", method: "confirm", title, message }),
      input: async (title: string) => void frames.push({ type: "extension_ui_request", method: "input", title }),
      editor: async (title: string, prefill?: string) => void frames.push({ type: "extension_ui_request", method: "editor", title, prefill }),
      notify: (message: string, notifyType: string) => void frames.push({ type: "extension_ui_request", method: "notify", message, notifyType }),
      custom: async () => undefined,
    };
    const rpc = makeCtx({ mode: "rpc", hasUI: true, ui: rpcUi });
    await send(t, rpc.ctx, userText(ALL_TEXT));
    frames.length = 0;
    await t.list(rpc.ctx);
    await t.shortcuts.get(LIST_KEY)!.handler(rpc.ctx);
    expect(frames.length).toBe(2);
    for (const f of frames) {
      expect(f.method).toBe("notify");
      expect(f.message).toBe("/pii list 需要在 omp 交互界面里查看（原值只在本机界面显示，这里不输出）");
      expect(f.notifyType).toBe("warning");
    }
    const wire = JSON.stringify(frames);
    for (const v of Object.values(V)) expect(wire).not.toContain(v);
  });

  test("mode 不是 tui（rpc、print、json）或缺失：不显示、不调任何 ui 原语；无界面走 stderr，有界面走固定提示的通知", async () => {
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    await send(t, makeCtx().ctx, userText(ALL_TEXT));
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      for (const over of [{ mode: "rpc" }, { mode: "print" }, { mode: "json" }, { mode: undefined }, { mode: "print", hasUI: false }, { mode: "json", hasUI: false }]) {
        const c = makeCtx(over);
        await t.list(c.ctx);
        expect(c.shown).toEqual([]);
        expect(c.forbidden).toEqual([]);
        const withUi = (over as { hasUI?: boolean }).hasUI !== false;
        expect(c.notes.length).toBe(withUi ? 1 : 0);
      }
    } finally {
      console.error = orig;
    }
    expect(errs.length).toBe(2);
    for (const v of Object.values(V)) expect(errs.join("\n")).not.toContain(v);
  });

  test("源码守卫：列表代码（src/index.ts、src/list-ui.ts）里没有 ui.select/confirm/input/editor 调用", () => {
    for (const f of ["../src/index.ts", "../src/list-ui.ts"]) {
      // 去掉块注释、整行注释和行尾注释再查（注释里会解释为什么不用 select）
      const src = fs
        .readFileSync(path.join(import.meta.dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\s\/\/ .*$/gm, "");
      expect(src).not.toMatch(/\bui\??\.(select|confirm|input|editor)\b/);
    }
  });

  test("openValueList 只调 ctx.ui.custom 一次、不带 overlay 选项以外的东西；关闭后 Promise 完成", async () => {
    const calls: unknown[][] = [];
    const ctx = {
      ui: {
        custom: async (factory: any, ...rest: unknown[]) => {
          calls.push(rest);
          const { comp, state } = await mountList(factory);
          comp.handleInput(ESC);
          expect(state.closed).toBe(true);
        },
      },
    };
    await openValueList(ctx, [item()]);
    expect(calls.length).toBe(1);
  });
});

describe("列表组件", () => {
  test("每一行都不超过终端宽度（CJK 与 emoji 占 2 列），过长的行以 … 结尾", () => {
    const items = [
      item({ value: "中".repeat(30) }),
      item({ ph: "{{PERSON_bbbbbbbb}}", value: "Zoë O'Brien 😀🎉 and a very long english name that goes on" }),
    ];
    for (const width of [20, 30, 60, 100]) {
      const { env: e } = env();
      const c = new ValueList(items, e);
      const frame = c.render(width);
      for (const row of frame) expect(columns(row)).toBeLessThanOrEqual(width);
      c.handleInput(ENTER);
      for (const row of c.render(width)) expect(columns(row)).toBeLessThanOrEqual(width);
    }
    expect(columns("中a😀")).toBe(5);
    expect(fit("中文字符串", 6)).toBe("中文…");
    expect(fit("abc", 3)).toBe("abc");
  });

  test("上下、翻页、到头不越界；一屏放不下时滚动，选中行始终在屏内，页脚显示位置", () => {
    const items = Array.from({ length: 50 }, (_, i) => item({ ph: `{{PERSON_${String(i).padStart(8, "a")}}}`, value: `值${i}` }));
    const { env: e, calls } = env({ rows: () => 12 }); // 一屏 5 项
    const c = new ValueList(items, e);
    const frame = () => c.render(WIDE);
    expect(frame().length).toBe(2 + 5 + 1);
    expect(footerPos(frame()).slice(1)).toEqual(["1", "50"]);
    c.handleInput(UP); // 到头
    expect(footerPos(frame())[1]).toBe("1");
    for (let i = 0; i < 7; i++) c.handleInput(DOWN);
    expect(footerPos(frame())[1]).toBe("8");
    expect(selectedRow(frame())).toContain("值7");
    expect(frame().join("\n")).toContain("值7");
    expect(frame().join("\n")).not.toContain("值0 "); // 已滚出屏
    c.handleInput(KEYS["tui.select.pageDown"]!);
    expect(footerPos(frame())[1]).toBe("13");
    for (let i = 0; i < 100; i++) c.handleInput(DOWN);
    expect(footerPos(frame())[1]).toBe("50");
    expect(selectedRow(frame())).toContain("值49");
    for (let i = 0; i < 20; i++) c.handleInput(KEYS["tui.select.pageUp"]!);
    expect(footerPos(frame())[1]).toBe("1");
    expect(calls.repaints).toBeGreaterThan(0);
  });

  test("Enter 看全文、Esc 层级：详情里 Esc/Enter 回到列表（不关闭），列表里 Esc 才关闭", () => {
    const { env: e, calls } = env();
    const c = new ValueList([item({ value: "完整原值甲" }), item({ ph: "{{PERSON_bbbbbbbb}}", value: "完整原值乙" })], e);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    const detail = c.render(WIDE);
    expect(detail[0]).toBe("人名 · {{PERSON_bbbbbbbb}} · 识别分数 0.99");
    expect(detail.join("\n")).toContain("完整原值乙");
    expect(detail.join("\n")).not.toContain("完整原值甲");
    c.handleInput(ESC);
    expect(calls.closed).toBe(0);
    expect(footerPos(c.render(WIDE))[1]).toBe("2"); // 回到列表，光标还在原处
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    expect(calls.closed).toBe(0);
    c.handleInput(ESC);
    expect(calls.closed).toBe(1);
  });

  test("未识别的按键被忽略：不重绘、状态不变", () => {
    const { env: e, calls } = env();
    const c = new ValueList([item()], e);
    const before = c.render(WIDE).join("\n");
    for (const k of ["x", "q", "\x1b[Z", "\x1b[C"]) c.handleInput(k);
    expect(calls.repaints).toBe(0);
    expect(c.render(WIDE).join("\n")).toBe(before);
  });

  test("详情：多行长值可滚动，逐屏看全，到头不越界；行数在页脚", () => {
    const value = Array.from({ length: 60 }, (_, i) => `第${i + 1}行内容`).join("\n");
    const { env: e } = env({ rows: () => 20 }); // 一屏 12 行
    const c = new ValueList([item({ value })], e);
    c.handleInput(ENTER);
    let f = c.render(WIDE);
    expect(f.at(-1)).toBe("第 1–12 行 / 共 60 行");
    expect(f.join("\n")).toContain("第1行内容");
    expect(f.join("\n")).not.toContain("第13行内容");
    c.handleInput(KEYS["tui.select.pageDown"]!);
    f = c.render(WIDE);
    expect(f.at(-1)).toBe("第 13–24 行 / 共 60 行");
    for (let i = 0; i < 20; i++) c.handleInput(KEYS["tui.select.pageDown"]!);
    f = c.render(WIDE);
    expect(f.at(-1)).toBe("第 49–60 行 / 共 60 行");
    expect(f.join("\n")).toContain("第60行内容");
    for (let i = 0; i < 100; i++) c.handleInput(UP);
    expect(c.render(WIDE).at(-1)).toBe("第 1–12 行 / 共 60 行");
  });

  test("详情：窄终端按列数折行，各行拼回去恰好是原值（含 CJK、emoji）；每行不超过宽度", () => {
    const value = "地址是北京市朝阳区建国路88号 Building 3, Room 1203, Kexing Science Park 😀 深圳市南山区科技园科苑路15号".repeat(3);
    const { env: e } = env({ rows: () => 1000 });
    const c = new ValueList([item({ kind: "地址", value })], e);
    c.handleInput(ENTER);
    const width = 40;
    const lines = c.render(width).slice(2).map((r) => r.slice(2));
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(columns(l)).toBeLessThanOrEqual(width - 2);
    expect(lines.join("")).toBe(value);
    expect(wrap("ab\ncd", 10)).toEqual(["ab", "cd"]);
    expect(wrap("", 10)).toEqual([""]);
  });

  test("主题着色出错（theme.fg 抛错）时回落成纯文本，不影响显示", () => {
    const { env: e } = env({ theme: { fg: () => { throw new Error("坏主题"); }, bold: () => { throw new Error("坏主题"); } } });
    const c = new ValueList([item()], e);
    expect(c.render(80).join("\n")).toContain("张三丰");
    const { env: e2 } = env({ theme: undefined });
    expect(new ValueList([item()], e2).render(80).join("\n")).toContain("张三丰");
  });

  test("真实主题给的着色（带 ANSI）不影响内容：去掉 ANSI 后与纯文本一致", () => {
    const ansi = { fg: (_c: string, s: string) => `\x1b[36m${s}\x1b[39m`, bold: (s: string) => `\x1b[1m${s}\x1b[22m` };
    const a = new ValueList([item()], env({ theme: ansi }).env).render(80);
    const b = new ValueList([item()], env().env).render(80);
    expect(a.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual([...b]);
  });

  test("listLabel / detailHeader 的格式", () => {
    expect(listLabel(item())).toBe("人名 · 张三丰 · {{PERSON_aaaaaaaa}} · 0.99");
    expect(detailHeader(item({ score: 1 }))).toBe("人名 · {{PERSON_aaaaaaaa}} · 识别分数 1.00");
  });
});

describe("文本中和：控制字符、零宽、双向控制符", () => {
  const cases: [string, number][] = [
    ["零宽空格 U+200B", 0x200b],
    ["零宽非连接符 U+200C", 0x200c],
    ["零宽连接符 U+200D", 0x200d],
    ["从左到右标记 U+200E", 0x200e],
    ["从右到左标记 U+200F", 0x200f],
    ["双向嵌入 U+202A", 0x202a],
    ["双向嵌入 U+202B", 0x202b],
    ["双向弹出 U+202C", 0x202c],
    ["从左到右覆盖 U+202D", 0x202d],
    ["从右到左覆盖 U+202E", 0x202e],
    ["词连接符 U+2060", 0x2060],
    ["函数应用 U+2061", 0x2061],
    ["不可见乘号 U+2062", 0x2062],
    ["不可见分隔符 U+2063", 0x2063],
    ["不可见加号 U+2064", 0x2064],
    ["双向隔离 U+2066", 0x2066],
    ["双向隔离 U+2067", 0x2067],
    ["双向隔离 U+2068", 0x2068],
    ["双向隔离弹出 U+2069", 0x2069],
    ["字节序标记 U+FEFF", 0xfeff],
    ["阿拉伯字母标记 U+061C", 0x061c],
    ["行分隔符 U+2028", 0x2028],
    ["段分隔符 U+2029", 0x2029],
    ["软连字符 U+00AD", 0x00ad],
    ["DEL U+007F", 0x7f],
    ["C1 控制符 U+009B（CSI）", 0x9b],
    ["C1 控制符 U+0085", 0x85],
  ];
  for (const [name, cp] of cases) {
    test(`${name}：visible 转成 ⟨U+XXXX⟩，列表行与详情里都不出现原字符`, () => {
      const ch = String.fromCodePoint(cp);
      const esc = `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
      expect(visible(`a${ch}b`, false)).toBe(`a${esc}b`);
      expect(visible(`a${ch}b`, true)).toBe(`a${esc}b`);
      const it = item({ value: `pay${ch}ment 123` });
      const label = listLabel(it);
      expect(label).toContain(esc);
      expect(label).not.toContain(ch);
      const { env: e } = env();
      const c = new ValueList([it], e);
      expect(c.render(80).join("\n")).not.toContain(ch);
      c.handleInput(ENTER);
      const detail = c.render(80).join("\n");
      expect(detail).toContain(esc);
      expect(detail).not.toContain(ch);
    });
  }

  test("RTL 覆盖不能把后面的字符倒过来显示：整串里的 U+202E 都被换成可见转义", () => {
    const v = "密码:\u202e1234\u202c结束";
    const shown = visible(v, true);
    expect(shown).toBe("密码:⟨U+202E⟩1234⟨U+202C⟩结束");
    expect(/[\u202a-\u202e\u2066-\u2069]/.test(shown)).toBe(false);
  });

  test("C0 控制符换成控制图片符（ESC → ␛、BEL → ␇、NUL → ␀）；详情里保留换行与制表，列表行里连换行制表也换掉", () => {
    expect(visible("a\u001bb\u0007c\u0000", false)).toBe("a\u241bb\u2407c\u2400");
    expect(visible("a\nb\tc", true)).toBe("a\nb\tc");
    expect(visible("a\nb\tc", false)).toBe("a\u240ab\u2409c");
  });

  test("普通字符不被改动：中文、英文、emoji、ZWJ 以外的组合标记、全角标点", () => {
    const v = "张三丰 Zoë 😀 ｆｕｌｌ，。";
    expect(visible(v, false)).toBe(v);
  });
});

describe("列表快捷键：不抢占别人的绑定；Tern 状态文件的 list 字段", () => {
  const marker = () => path.join(dir, "list-key-taken");
  const readList = async (pane: number): Promise<boolean | undefined> => {
    const rt = testHooks.runtime();
    for (let i = 0; i < 400 && rt.tern?.pending; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    return JSON.parse(fs.readFileSync(path.join(ternDir, `${pane}.json`), "utf8")).list;
  };
  const keyNotes = (notes: { msg: string; level: string }[]) => notes.filter((n) => n.msg.includes("快捷键"));

  test("没人占用：注册快捷键，状态文件 list = true，没有提示、没有标记文件", async () => {
    process.env.TERN_PANE = "7";
    fresh();
    const t = makePi();
    piiGuard(t.pi);
    expect(t.shortcuts.has(LIST_KEY)).toBe(true);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(testHooks.runtime().listKey).toBe(true);
    expect(await readList(7)).toBe(true);
    expect(keyNotes(notes)).toEqual([]);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test("session_start 发现被占用（keybinding / extension / reserved）：list = false，警告一次（含种类、不含值），留下标记；/pii list 照常可用", async () => {
    for (const held of [{ kind: "keybinding", keybindings: ["x"] }, { kind: "extension", extensionPath: "/x" }, { kind: "reserved" }]) {
      process.env.TERN_PANE = "7";
      fresh();
      fs.rmSync(marker(), { force: true });
      const t = makePi();
      t.conflicts.set(LIST_KEY, held);
      piiGuard(t.pi);
      const { ctx, notes, shown, answers } = makeCtx();
      await t.emit("session_start", {}, ctx);
      expect(testHooks.runtime().listKey).toBe(false);
      expect(await readList(7)).toBe(false);
      const w = keyNotes(notes);
      expect(w.length).toBe(1);
      expect(w[0]!.level).toBe("warning");
      expect(w[0]!.msg).toContain(held.kind);
      expect(w[0]!.msg).toContain("/pii list");
      expect(fs.existsSync(marker())).toBe(true);
      // 命令照常
      await send(t, ctx, userText(`手机 ${V.zhPhone}`));
      answers.push(() => undefined);
      await t.list(ctx);
      expect(shown.length).toBe(1);
    }
  });

  test("有标记时下次启动不再注册（不抢占）；仍被占用时保持安静，list = false，标记还在", async () => {
    process.env.TERN_PANE = "7";
    fresh();
    fs.writeFileSync(marker(), "x");
    const t = makePi();
    t.conflicts.set(LIST_KEY, { kind: "extension", extensionPath: "/other" });
    piiGuard(t.pi);
    expect(t.shortcuts.has(LIST_KEY)).toBe(false);
    expect(t.commands.has("pii")).toBe(true);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(keyNotes(notes)).toEqual([]);
    expect(fs.existsSync(marker())).toBe(true);
    expect(await readList(7)).toBe(false);
  });

  test("有标记但快捷键已空闲：本次仍不注册（list = false），删标记并提示重启后恢复；再下次启动注册、list = true", async () => {
    process.env.TERN_PANE = "7";
    fresh();
    fs.writeFileSync(marker(), "x");
    const t = makePi();
    piiGuard(t.pi);
    expect(t.shortcuts.has(LIST_KEY)).toBe(false);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(fs.existsSync(marker())).toBe(false);
    const n = keyNotes(notes);
    expect(n.length).toBe(1);
    expect(n[0]!.level).toBe("info");
    expect(n[0]!.msg).toContain("重启");
    expect(await readList(7)).toBe(false);
    // 下次启动
    testHooks.reset();
    fresh();
    const t2 = makePi();
    piiGuard(t2.pi);
    expect(t2.shortcuts.has(LIST_KEY)).toBe(true);
    await t2.emit("session_start", {}, makeCtx().ctx);
    expect(await readList(7)).toBe(true);
  });

  test("占用 → 标记 → 下次不注册 → 空闲 → 恢复：完整往返", async () => {
    fresh();
    const a = makePi();
    a.conflicts.set(LIST_KEY, { kind: "extension", extensionPath: "/other" });
    piiGuard(a.pi);
    await a.emit("session_start", {}, makeCtx().ctx);
    expect(fs.existsSync(marker())).toBe(true);
    testHooks.reset();
    fresh();
    const b = makePi();
    b.conflicts.set(LIST_KEY, { kind: "extension", extensionPath: "/other" });
    piiGuard(b.pi);
    expect(b.shortcuts.has(LIST_KEY)).toBe(false);
    await b.emit("session_start", {}, makeCtx().ctx);
    testHooks.reset();
    fresh();
    const c = makePi();
    piiGuard(c.pi);
    expect(c.shortcuts.has(LIST_KEY)).toBe(false);
    await c.emit("session_start", {}, makeCtx().ctx);
    expect(fs.existsSync(marker())).toBe(false);
    testHooks.reset();
    fresh();
    const d = makePi();
    piiGuard(d.pi);
    expect(d.shortcuts.has(LIST_KEY)).toBe(true);
  });

  test("omp 没有 getShortcutConflict（旧版本）：无法确认，list = false，不写标记", async () => {
    process.env.TERN_PANE = "7";
    fresh();
    const t = makePi();
    (t.pi as any).getShortcutConflict = undefined;
    piiGuard(t.pi);
    expect(t.shortcuts.has(LIST_KEY)).toBe(true);
    const { ctx, notes } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(keyNotes(notes)).toEqual([]);
    expect(await readList(7)).toBe(false);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test("getShortcutConflict 抛错（加载阶段的行为）：当作无法确认，不影响启动", async () => {
    process.env.TERN_PANE = "7";
    fresh();
    const t = makePi();
    (t.pi as any).getShortcutConflict = () => {
      throw new Error("Extension runtime not initialized");
    };
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(await readList(7)).toBe(false);
  });

  test("无界面、子代理、非 tui 模式：不检查快捷键、不写标记、不提示", async () => {
    for (const over of [{ hasUI: false }, { agent: { kind: "sub" } }, { mode: "rpc" }]) {
      fresh();
      fs.rmSync(marker(), { force: true });
      const t = makePi();
      t.conflicts.set(LIST_KEY, { kind: "reserved" });
      piiGuard(t.pi);
      const c = makeCtx(over);
      await t.emit("session_start", {}, c.ctx);
      expect(keyNotes(c.notes)).toEqual([]);
      expect(fs.existsSync(marker())).toBe(false);
      expect(testHooks.runtime().listKey).toBe(false);
    }
  });

  test("标记文件写不进去（数据目录是个文件）：只记 debug，不抛错、不影响启动", async () => {
    fresh();
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "x");
    const rt = testHooks.runtime();
    rt.paths = { ...rt.paths, root: blocked };
    const t = makePi();
    t.conflicts.set(LIST_KEY, { kind: "reserved" });
    piiGuard(t.pi);
    const { ctx } = makeCtx();
    await t.emit("session_start", {}, ctx);
    expect(t.debug.some((d) => d.includes("标记"))).toBe(true);
    expect(rt.listKey).toBe(false);
  });
});
