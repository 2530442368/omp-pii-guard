// 移植自 magpie internal/redact/zhname.go。
//
// 模型漏掉很多中文名：“写封信给张伟，他住在…” 里的张伟、李娜、客户后面的陈建国都不会被标出来，
// 阈值再低也一样；它找到的名字又常常带着后面的话（「王芳，她下周一」「张伟先生」「林黛玉进贾府」）。
// 所以开着模型时还要像人读句子那样找名字：一个姓，后面一两个字，周围有话说这里指的是人
// （客户、我叫、给…发、…先生、…说）。光有姓、周围什么也没有的不遮：王国的军队、张开的括号不是谁。
//
// 偏移按 UTF-16 下标。magpie 在 Go 里用字节下标并逐 rune 解码，这里改为按码点前进、按码元定位，
// 结果区间的含义不变。

import type { Span } from "./types.ts";
import {
  cpAt,
  cpBefore,
  isHanCp,
  isPunctCp,
  isSpaceCp,
  trimRightSet,
} from "./text.ts";
import {
  ZH_COLOURS,
  ZH_COMPOUND,
  ZH_DICT_WORDS,
  ZH_NICK_SURNAMES,
  ZH_NOT_GIVEN,
  ZH_NOUN_ENDS,
  ZH_SURNAMES,
  ZH_WORDS,
} from "./zhdata.ts";

/** 以姓开头但是普通词的双字词：手工列表（文案、毛利、白名……）。词表正文见 zhdata.ts。 */
const zhWords: ReadonlySet<string> = new Set(ZH_WORDS);

/** 另约 1500 个同类词，来自词典（边界、应该、尚可、关心、高兴）。 */
const zhDict: ReadonlySet<string> = new Set(ZH_DICT_WORDS);

/** 前面有这些词，后面就是人名：客户陈建国、联系人：赵丽颖、我叫黄晓明、提交者是欧阳娜娜。 */
export const zhRoles: readonly string[] = [
  "客户", "联系人", "作者", "提交者", "审核人", "审批人", "负责人", "经办人", "收件人", "发件人", "收货人", "申请人", "报告人",
  "同事", "姓名", "名字", "署名", "签名", "我叫", "他叫", "她叫", "名叫", "叫做", "尊敬的", "亲爱的", "致", "@",
];

/** 后面跟人的词（给张伟、问李娜）：名字在它们后面时，还要后面也有话说是人才算。 */
const zhBefore: readonly string[] = [
  "给", "找", "问", "让", "告诉", "通知", "联系", "抄送", "转给", "交给", "一下", "叫", "和", "与", "跟", "说", "请", "我是", "他是", "她是",
];

/** 跟在人后面的词（张伟先生、马云说、张三反馈）。 */
const zhAfter: readonly string[] = [
  "先生", "女士", "小姐", "老师", "同学", "同志", "经理", "总监", "主任", "师傅", "医生", "律师", "教授", "博士",
  "说", "讲", "表示", "认为", "反馈", "提到", "提交", "负责", "告诉", "回复", "发", "打", "明天", "今天", "昨天", "已经", "他", "她",
];

/**
 * zhAfter 里任何主语后面都能跟的（物也可以：文案已经改好了、文案明天给你、文档提交）：
 * 在句首、前面没有指人的话时，它们什么也说明不了。
 */
const zhAnyAfter: readonly string[] = ["提交", "负责", "回复", "明天", "今天", "昨天", "已经", "他", "她"];

/** “一下”之前只有这些动词接人（问一下张伟、联系一下李娜）；别的动词后面“一下”接的是物（改一下文案、检查一下文档）。 */
const zhAskVerbs: readonly string[] = [
  "问", "找", "叫", "喊", "催", "请", "联系", "通知", "告诉", "提醒", "回复", "答复", "拜访", "采访", "抄送", "转告", "感谢", "谢谢", "艾特", "@",
];

/** 模型会把它们连在名字后面带进来，但它们不是名字的一部分。 */
export const zhTitles: readonly string[] = [
  "先生", "女士", "小姐", "老师", "同学", "同志", "经理", "总监", "主任", "师傅", "医生", "律师", "教授", "博士",
];

const isSurname: ReadonlySet<string> = new Set(ZH_SURNAMES);
const isNick: ReadonlySet<string> = new Set(ZH_NICK_SURNAMES);
const notGiven: ReadonlySet<string> = new Set(ZH_NOT_GIVEN);
/** 名字可以由它们开头：单姓、复姓首字、小、老。全是 BMP 字符。 */
const mayStart: ReadonlySet<string> = new Set(ZH_SURNAMES + ZH_COMPOUND.map((c) => c[0]).join("") + "小老");

/** 两个码点以内的前缀（取 s[i:] 开头两个字符）在手工词表里。 */
function zhWord(s: string, i: number): boolean {
  const [, n] = cpAt(s, i);
  const [, n2] = cpAt(s, i + n);
  return zhWords.has(s.slice(i, i + n + n2));
}

/** 值里有汉字（码点 ≥0x3400 的汉字；0x3400 以下的部首、〇 之类不算，同 magpie）。 */
export function hasHan(s: string): boolean {
  if (!/\p{Script=Han}/u.test(s)) return false;
  for (let i = 0; i < s.length; ) {
    const [cp, n] = cpAt(s, i);
    if (cp >= 0x3400 && isHanCp(cp)) return true;
    i += n;
  }
  return false;
}

/**
 * v（模型或线索当成中文名的东西）是普通词：颜色（黄绿色，hh05928822 on X）、以姓开头的词
 * （zhWords、zhDict：边界、尚可）、或这样的词后面再加一个让它成为更长词的字（关键词、关键字，
 * wangjunxiao128 on X；应用层）。姓本身保留：黄既开头黄绿色也开头黄晓明。
 */
function zhWordShaped(v: string): boolean {
  const rs = Array.from(v);
  if (rs.length < 2) return false;
  let colour = true;
  for (const r of rs) {
    if (!isHanCp(r.codePointAt(0)!)) return false;
    colour = colour && ZH_COLOURS.includes(r);
  }
  if (colour || rs[rs.length - 1] === "色") return true;
  const two = rs[0]! + rs[1]!;
  switch (rs.length) {
    case 2:
      return zhWords.has(two) || zhDict.has(two);
    case 3:
      return (zhWords.has(two) || zhDict.has(two)) && ZH_NOUN_ENDS.includes(rs[2]!);
  }
  return false;
}

/**
 * s[a:b] 被当成中文名，但在那里是普通词（zhWordShaped）：除非前面有角色词或后面有称谓说明指的是人
 * （客户方圆、我叫高歌、江山老师），这时与词同形的名字照遮。
 */
export function zhWordNotName(s: string, a: number, b: number): boolean {
  return zhWordShaped(s.slice(a, b)) && !endsAny(s.slice(0, a), zhRoles, true) && !startsAnyAt(s, b, zhTitles);
}

/**
 * 补找模型没找到的中文名，返回 PERSON 区间；person 是模型已找到的。nicks 为 true 时只补昵称
 * （小王、老李）：AstrLink Guard 自己能找其余的，而这里的线索曾把词当成名字（关键发现、易触发；xuanwo on X）。
 */
export function zhNameSpans(s: string, person: readonly Span[], nicks: boolean): Span[] {
  if (!hasHan(s)) return [];
  // 候选；person 为 true 的是确认是名字的
  const cs: { start: number; end: number; person: boolean }[] = [];
  for (let i = 0; i < s.length; ) {
    const r = zhName(s, i);
    if (!r) {
      i += cpAt(s, i)[1];
      continue;
    }
    const [a, b, ok] = r;
    i = b;
    if ((nicks && !zhNick(s.slice(a, b))) || zhWordNotName(s, a, b)) continue; // 是词，也没有和名字连着：张伟和边界
    cs.push({ start: a, end: b, person: ok });
  }
  // 由 和、与、跟、及、、 连着一个确认的名字的，也是名字：李娜和刘洋，只有刘洋后面的话说它是人
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const p of person) {
    starts.add(p.start);
    ends.add(p.end);
  }
  for (const c of cs) {
    if (c.person) {
      starts.add(c.start);
      ends.add(c.end);
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of cs) {
      if (!c.person && joined(s, c, starts, ends)) {
        c.person = true;
        grew = true;
        starts.add(c.start);
        ends.add(c.end);
      }
    }
  }
  return cs.filter((c) => c.person).map((c) => ({ start: c.start, end: c.end, kind: "PERSON" as const }));
}

/** name 是昵称：小或老加一个姓（小王、老李）。 */
function zhNick(name: string): boolean {
  const rs = Array.from(name);
  return rs.length === 2 && (rs[0] === "小" || rs[0] === "老") && isNick.has(rs[1]!);
}

/** c 与一个名字之间只隔着 和、与、跟、及 或 、，那个名字以 ends 之一结束或以 starts 之一开始。 */
function joined(s: string, c: { start: number; end: number }, starts: Set<number>, ends: Set<number>): boolean {
  for (const j of ["和", "与", "跟", "及", "、"]) {
    if ((s.startsWith(j, c.end) && starts.has(c.end + j.length)) || (s.slice(0, c.start).endsWith(j) && ends.has(c.start - j.length))) {
      return true;
    }
  }
  return false;
}

/**
 * 可能从 i 起的名字：[起点, 终点, 周围的话是否说它是名字]；不可能从这里起则为 null。
 */
function zhName(s: string, i: number): [number, number, boolean] | null {
  if (!mayStart.has(s[i]!)) return null;
  let sur = 0;
  for (const c of ZH_COMPOUND) {
    if (s.startsWith(c, i)) {
      sur = c.length;
      break;
    }
  }
  let nick = false;
  if (sur === 0) {
    const r = s[i]!;
    if ((r === "小" || r === "老") && s.length > i + 1) {
      if (isNick.has(s[i + 1]!)) {
        sur = 2;
        nick = true;
      }
    } else if (isSurname.has(r)) {
      sur = 1;
    }
  }
  if (sur === 0) return null;
  // 名：小王之后没有；否则一个或两个字
  const ends: number[] = [];
  if (nick) {
    ends.push(i + sur);
  } else {
    let at = i + sur;
    for (let k = 0; k < 2 && at < s.length; k++) {
      const [r, n] = cpAt(s, at);
      if (!isHanCp(r) || notGiven.has(String.fromCodePoint(r))) break;
      at += n;
      ends.push(at);
    }
  }
  if (ends.length === 0) return null;
  if (zhWord(s, i)) return null;
  // 前面是个不是线索的汉字，就是词的一部分（建国路），除非线索恰好在那里结束
  const before = s.slice(0, i);
  const role = endsAny(before, zhRoles, true);
  let verb = endsAny(before, zhBefore, false);
  // 和、与连的是同类：前面有人才连人（吴敏和郑浩、我和张伟），判断和边界不是
  for (const j of ["和", "与"]) {
    if (before.endsWith(j) && verb) verb = personBefore(before.slice(0, -j.length));
  }
  // “一下”只在询问类动词后面接人（问一下张伟），不在改一下文案
  if (before.endsWith("一下") && verb) verb = endsAny(before.slice(0, -"一下".length), zhAskVerbs, false);
  const start = sentenceStart(before);
  if (!role && !verb && !start) return null;
  // 姓加称谓是人（孙经理、邓总）
  if (!nick) {
    for (const t of [...zhTitles, "总"]) {
      if (s.startsWith(t, i + sur) && !(t === "总" && zhTotal(s, i + sur + t.length))) {
        return [i, i + sur + t.length, true];
      }
    }
  }
  // 最长的、后面有话说它是人的
  for (let k = ends.length - 1; k >= 0; k--) {
    const e = ends[k]!;
    const after = s.slice(e);
    if (startsAny(after, zhAfter) && !wordAfter(after) && (role || verb || !startsAny(after, zhAnyAfter))) {
      return [i, e, true];
    }
    if ((role || verb) && endsWord(after)) return [i, e, true];
  }
  if (role) return [i, ends[ends.length - 1]!, true];
  return [i, ends[ends.length - 1]!, false];
}

/** s[at] 处的 总 是词里的（总是、总结、总共），不是称谓。 */
function zhTotal(s: string, at: number): boolean {
  const [r] = cpAt(s, at);
  return r >= 0 && "是结共体之数计线量部归算会得要".includes(String.fromCodePoint(r));
}

/** s 以 ws 之一结尾；role 为 true 时，以其后跟 是、为、冒号或空格的 ws 之一结尾也算。 */
export function endsAny(s: string, ws: readonly string[], role: boolean): boolean {
  if (role) {
    s = trimRightSet(s, " \t");
    for (const sep of ["：", ":", "是", "为"]) {
      if (s.endsWith(sep)) {
        s = trimRightSet(s.slice(0, -sep.length), " \t");
        break;
      }
    }
  }
  return ws.some((w) => s.endsWith(w));
}

export function startsAny(s: string, ws: readonly string[]): boolean {
  return ws.some((w) => s.startsWith(w));
}

/** s[at:] 以 ws 之一开头（不复制子串）。 */
export function startsAnyAt(s: string, at: number, ws: readonly string[]): boolean {
  return ws.some((w) => s.startsWith(w, at));
}

/** 一个词在 s 开头结束：s 为空，或开头不是汉字。 */
function endsWord(s: string): boolean {
  return s === "" || !isHanCp(cpAt(s, 0)[0]);
}

/**
 * 名字可以从 s 之后开始：s 为空，或以标点结尾（其后可有空格或没有）。词或代码之后的空格
 * （`gh pr view` 易触发）在句子中间。
 */
function sentenceStart(s: string): boolean {
  s = trimRightSet(s, " \t\u3000");
  if (s === "") return true;
  const [r] = cpBefore(s, s.length);
  return isPunctCp(r) || isSpaceCp(r);
}

/**
 * s 开头的 发 或 打 是一个词的开头（发现、打开），不是人做的动作（发了个消息、打给他）；
 * 说明、讲解也是（文案说明要简短），说明天除外（张伟说明天来）。
 */
function wordAfter(s: string): boolean {
  for (const w of ["说明", "说法", "讲解", "讲座", "讲义", "讲究"]) {
    if (s.startsWith(w)) return !s.startsWith("说明天");
  }
  for (const v of ["发", "打"]) {
    if (s.startsWith(v)) {
      const [r, n] = cpAt(s, v.length);
      return n > 0 && isHanCp(r) && !"了个给过一".includes(String.fromCodePoint(r));
    }
  }
  return false;
}

/** s 以代词或可能是名字的东西结尾：一个姓加一到三个字，且不是 zhWords 里的词。 */
function personBefore(s: string): boolean {
  const [last] = cpBefore(s, s.length);
  if (last >= 0 && "我你您他她们".includes(String.fromCodePoint(last))) return true;
  // 只取末尾几个码点：magpie 把整个 s 转成 []rune，文本长时每个候选都要付整段长度
  const rs = Array.from(s.slice(-16));
  for (let n = 2; n <= 4 && n <= rs.length; n++) {
    const u = rs.slice(rs.length - n).join("");
    if (!mayStart.has(rs[rs.length - n]!) || !hasHan(u)) continue;
    if (!zhWord(u, 0)) return true;
  }
  return false;
}

/**
 * 模型给的名字 s[a:b] 去掉它连带吃进去的东西：在汉字之后的第一个标点处截断，在称谓处截断
 * （张伟先生）。名字后面还跟着话的（林黛玉进贾府）保持原样：四个字的名字常常就是完整的名字（田中太郎）。
 */
export function zhTrim(s: string, a: number, b: number): [number, number] {
  let v = s.slice(a, b);
  if (!hasHan(v)) return [a, b];
  let han = false;
  let count = 0; // v[:k] 的码点数
  for (let k = 0; k < v.length; ) {
    const [cp, n] = cpAt(v, k);
    if (han && isPunctCp(cp) && cp !== 0xb7 && cp !== 0x30fb && count >= 2) {
      v = v.slice(0, k);
      break;
    }
    han = han || isHanCp(cp);
    count++;
    k += n;
  }
  count = 0;
  for (let k = 0; k < v.length; ) {
    if (count >= 2 && startsAnyAt(v, k, zhTitles)) {
      v = v.slice(0, k);
      break;
    }
    count++;
    k += cpAt(v, k)[1];
  }
  return [a, a + v.length];
}
