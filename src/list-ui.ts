// /pii list 的界面：用 ctx.ui.custom 画一个只在本机显示的列表（上下选择、Enter 看原值全文、Esc 返回/关闭）。
//
// 为什么不用 ctx.ui.select：omp 18.18.x 的 select 会经 showCollabAwareSelector → #raceCollabDialog → host.requestGuestUi
// 转发给协作访客，RPC 模式下还会把选项写进 extension_ui_request 帧——原值会因此离开本机界面。
// custom 只在本机 TUI 里渲染组件（interactive 模式的 showHookCustom：不经协作转发，RPC 里是空操作），
// 所以原值只出现在这个组件的 render() 结果里。调用方（src/index.ts 的 showList）还要先确认 ctx.mode === "tui"。
//
// 组件不依赖 @oh-my-pi/* 的任何导入（测试里没有这些包）：按键用工厂传进来的 keybindings.matches，
// 宽度按终端列数自己算（CJK/全角/emoji 占 2 列），主题着色是可选的（没有或出错就用纯文本）。
//
// 原值里的控制字符、零宽字符、双向控制符一律转成可见的图形或 ⟨U+XXXX⟩ 转义，别让它在终端里被当成指令、
// 隐藏字符或改变显示顺序。列表行里原值过长会截断（LIST_MAX_VALUE），选中后在详情里看全文（按列数折行，可滚动）。

/** 列表里一行最多显示的原值字符数（超出截断，选中后看全文）；再长的话占位符与分数会被挤出一行。 */
export const LIST_MAX_VALUE = 40;

/** 列表里的一项：本会话遮挡过的一个值。kind 是类别的中文名。 */
export interface ListItem {
  kind: string;
  ph: string;
  value: string;
  score: number;
}

/** 控制字符（C0、DEL、C1）、行/段分隔符、零宽字符与双向控制符。 */
const NEUTRALIZE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/**
 * 让原值在终端里只表现为“可读的字符”：C0 控制符换成控制图片符（ESC → ␛），其余（DEL、C1、零宽、双向控制符、
 * 行/段分隔符、软连字符）换成 ⟨U+XXXX⟩ 转义。`keepLines` 时保留换行与制表符（详情里按行显示）。
 */
export function visible(s: string, keepLines: boolean): string {
  return s.replace(NEUTRALIZE, (c) => {
    const cp = c.codePointAt(0)!;
    if (keepLines && (cp === 0x0a || cp === 0x09)) return c;
    if (cp <= 0x1f) return String.fromCharCode(0x2400 + cp);
    return `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}

const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];
const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean => ranges.some(([a, b]) => cp >= a && cp <= b);

/** 一个码点占的终端列数。 */
function cellWidth(cp: number): number {
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** 字符串占的终端列数。 */
export function columns(s: string): number {
  let n = 0;
  for (const ch of s) n += cellWidth(ch.codePointAt(0)!);
  return n;
}

/** 截到最多 width 列；被截掉时末尾补 …（也算在 width 内）。 */
export function fit(s: string, width: number): string {
  if (columns(s) <= width) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = cellWidth(ch.codePointAt(0)!);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** 按列数折行（保留原有换行；制表符按 4 个空格）。空串返回 [""]。 */
export function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  for (const line of s.split("\n")) {
    let cur = "";
    let used = 0;
    for (const ch of line.replace(/\t/g, "    ")) {
      const w = cellWidth(ch.codePointAt(0)!);
      if (used + w > width && cur !== "") {
        out.push(cur);
        cur = "";
        used = 0;
      }
      cur += ch;
      used += w;
    }
    out.push(cur);
  }
  return out;
}

/** 列表里的一行：类别 · 原值（过长截断）· 占位符 · 分数。占位符唯一，所以每行都不同。 */
export function listLabel(it: ListItem): string {
  const chars = [...it.value];
  const v = visible(chars.length > LIST_MAX_VALUE ? `${chars.slice(0, LIST_MAX_VALUE).join("")}…` : it.value, false);
  return `${it.kind} · ${v} · ${it.ph} · ${it.score.toFixed(2)}`;
}

/** 详情的标题行：类别 · 占位符 · 识别分数。 */
export function detailHeader(it: ListItem): string {
  return `${it.kind} · ${it.ph} · 识别分数 ${it.score.toFixed(2)}`;
}

/** 组件用到的宿主能力（factory 传进来的 tui、theme、keybindings 的子集）。 */
export interface ListEnv {
  /** 终端行数（决定一屏显示几项）。 */
  rows(): number;
  theme?: { fg?: (color: string, text: string) => string; bold?: (text: string) => string };
  kb: { matches(data: string, id: string): boolean };
  /** 关闭列表。 */
  close(): void;
  /** 请求重绘。 */
  repaint(): void;
}

/** 一屏最多显示的列表项（行数不够时至少 5 项）。 */
function pageSize(rows: number): number {
  return Math.max(5, Math.min(rows - 8, 20));
}

type View = "list" | "detail";

/** 宽度不小于它时给列表行与详情行留 2 列前缀（"› " / 缩进）；再窄就去掉前缀，把列数全留给内容。 */
const PREFIX_MIN = 6;

/** 原值列表组件：列表层（上下选择）和详情层（原值全文，可滚动）。 */
export class ValueList {
  #view: View = "list";
  #cur = 0;
  #top = 0;
  #dTop = 0;
  #detail: { width: number; lines: string[] } | undefined;

  constructor(
    private readonly items: readonly ListItem[],
    private readonly env: ListEnv,
  ) {}

  invalidate(): void {
    this.#detail = undefined;
  }

  #fg(color: string, text: string): string {
    try {
      return this.env.theme?.fg ? this.env.theme.fg(color, text) : text;
    } catch {
      return text;
    }
  }

  #bold(text: string): string {
    try {
      return this.env.theme?.bold ? this.env.theme.bold(text) : text;
    } catch {
      return text;
    }
  }

  render(width: number): string[] {
    // 按实际宽度画，不放大：放大会让折行后的行比终端还宽，被终端裁掉的字符就再也看不到了
    const w = Math.max(1, Math.floor(width));
    return this.#view === "list" ? this.#renderList(w) : this.#renderDetail(w);
  }

  #renderList(w: number): string[] {
    const page = pageSize(this.env.rows());
    if (this.#cur < this.#top) this.#top = this.#cur;
    if (this.#cur >= this.#top + page) this.#top = this.#cur - page + 1;
    const out = [
      this.#bold(fit(`本会话遮挡的值（${this.items.length} 个）`, w)),
      this.#fg("dim", fit("↑↓ 选择 · Enter 看原值全文 · Esc 关闭 · 原值只在本机界面显示", w)),
    ];
    const end = Math.min(this.items.length, this.#top + page);
    for (let i = this.#top; i < end; i++) {
      const pre = w >= PREFIX_MIN ? 2 : 0; // 极窄时去掉 "› " 前缀，只靠着色标出选中项
      const text = fit(listLabel(this.items[i]!), w - pre);
      out.push(i === this.#cur ? this.#fg("accent", `${pre ? "› " : ""}${text}`) : `${pre ? "  " : ""}${text}`);
    }
    out.push(this.#fg("dim", fit(`第 ${this.#cur + 1}/${this.items.length} 项`, w)));
    return out;
  }

  #detailLines(w: number): string[] {
    // 内容宽度 = 终端宽度减去 2 列缩进；窄到放不下缩进时去掉缩进，每个字符仍然都能显示（宽字符在 1 列里单独占一行）
    if (this.#detail?.width !== w) this.#detail = { width: w, lines: wrap(visible(this.items[this.#cur]!.value, true), w >= PREFIX_MIN ? w - 2 : w) };
    return this.#detail.lines;
  }

  #renderDetail(w: number): string[] {
    const it = this.items[this.#cur]!;
    const lines = this.#detailLines(w);
    const page = pageSize(this.env.rows());
    this.#dTop = Math.max(0, Math.min(this.#dTop, lines.length - page));
    const scroll = lines.length > page;
    const out = [
      this.#bold(fit(detailHeader(it), w)),
      this.#fg("dim", fit(`${scroll ? "↑↓ 滚动 · " : ""}Enter / Esc 返回列表 · 原值只在本机界面显示`, w)),
    ];
    const indent = w >= PREFIX_MIN ? "  " : "";
    for (const l of lines.slice(this.#dTop, this.#dTop + page)) out.push(`${indent}${l}`);
    if (scroll) out.push(this.#fg("dim", fit(`第 ${this.#dTop + 1}–${Math.min(lines.length, this.#dTop + page)} 行 / 共 ${lines.length} 行`, w)));
    return out;
  }

  handleInput(data: string): void {
    const kb = this.env.kb;
    if (this.#view === "detail") {
      const page = pageSize(this.env.rows());
      if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm") || data === "\n") this.#view = "list";
      else if (kb.matches(data, "tui.select.up")) this.#dTop = Math.max(0, this.#dTop - 1);
      else if (kb.matches(data, "tui.select.down")) this.#dTop += 1;
      else if (kb.matches(data, "tui.select.pageUp")) this.#dTop = Math.max(0, this.#dTop - page);
      else if (kb.matches(data, "tui.select.pageDown")) this.#dTop += page;
      else return;
      this.env.repaint();
      return;
    }
    const page = pageSize(this.env.rows());
    const last = this.items.length - 1;
    if (kb.matches(data, "tui.select.cancel")) {
      this.env.close();
      return;
    }
    if (kb.matches(data, "tui.select.up")) this.#cur = Math.max(0, this.#cur - 1);
    else if (kb.matches(data, "tui.select.down")) this.#cur = Math.min(last, this.#cur + 1);
    else if (kb.matches(data, "tui.select.pageUp")) this.#cur = Math.max(0, this.#cur - page);
    else if (kb.matches(data, "tui.select.pageDown")) this.#cur = Math.min(last, this.#cur + page);
    else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
      this.#view = "detail";
      this.#dTop = 0;
      this.#detail = undefined;
    } else return;
    this.env.repaint();
  }
}

/**
 * 在本机界面打开原值列表，等用户关闭。调用方先确认 ctx.mode === "tui" 且 ctx.hasUI（见 src/index.ts 的 showList）。
 * 只用 ctx.ui.custom：它只在本机 TUI 里渲染，不会像 select/confirm/input/editor 那样转发给协作访客或写进 RPC 帧。
 */
export async function openValueList(ctx: any, items: readonly ListItem[]): Promise<void> {
  await ctx.ui.custom((tui: any, theme: any, kb: any, done: (r?: unknown) => void) =>
    new ValueList(items, {
      rows: () => (typeof tui?.terminal?.rows === "number" ? tui.terminal.rows : 24),
      theme,
      kb,
      close: () => done(),
      repaint: () => tui?.requestRender?.(),
    }),
  );
}
