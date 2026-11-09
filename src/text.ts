// 字符串小工具。magpie 是 Go 字节下标，这里全部按 JS 字符串下标（UTF-16 码元）重写；
// 凡 magpie 按字节判断的 ASCII、按字节取窗口的地方，语义不变、单位换成码元，各处注释会写明。

export function isSpaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** magpie `isSpace`：空格、制表、换行、回车。 */
export function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** magpie `wordByte`：ASCII 字母、数字、下划线。非 ASCII 码元一律不是。 */
export function isWordCode(c: number): boolean {
  return c === 95 || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
}

/** s[i] 存在且是 word 字符（越界为 false）。 */
export function wordAt(s: string, i: number): boolean {
  return i >= 0 && i < s.length && isWordCode(s.charCodeAt(i));
}

/** 去掉 s 左侧属于 set 的字符（set 里都是 BMP 字符）。等价 Go `strings.TrimLeft`。 */
export function trimLeftSet(s: string, set: string): string {
  let i = 0;
  while (i < s.length && set.includes(s[i]!)) i++;
  return i === 0 ? s : s.slice(i);
}

/** 去掉 s 右侧属于 set 的字符。等价 Go `strings.TrimRight`。 */
export function trimRightSet(s: string, set: string): string {
  let e = s.length;
  while (e > 0 && set.includes(s[e - 1]!)) e--;
  return e === s.length ? s : s.slice(0, e);
}

/** s[start:end) 右端去掉 set 字符后的结束下标（不创建子串）。 */
export function trimRightIdx(s: string, end: number, set: string): number {
  while (end > 0 && set.includes(s[end - 1]!)) end--;
  return end;
}

/** 等价 Go `strings.Trim(v, digits) == ""`：空串或全是 ASCII 数字。 */
export function allDigits(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

export function countDigits(v: string): number {
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 48 && c <= 57) n++;
  }
  return n;
}

/** magpie `isASCII`：没有 ≥0x80 的字符。 */
export function isASCII(v: string): boolean {
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) >= 0x80) return false;
  return true;
}

/** UTF-8 字节数。magpie 里按 `len(v)` 判长度的地方（minKnown、密钥最短 8）保留字节语义。 */
export function byteLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const WS = /[\p{White_Space}]+/u;

/** 等价 Go `strings.Fields`。 */
export function fields(s: string): string[] {
  const out = s.split(WS);
  if (out.length && out[0] === "") out.shift();
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** 码点数。 */
export function runeCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
    n++;
  }
  return n;
}

/** s[i] 处的码点和它占的码元数；越界返回 [-1, 0]。 */
export function cpAt(s: string, i: number): [number, number] {
  if (i < 0 || i >= s.length) return [-1, 0];
  const c = s.codePointAt(i)!;
  return [c, c > 0xffff ? 2 : 1];
}

/** s[:end) 的最后一个码点和占的码元数；空串返回 [-1, 0]。 */
export function cpBefore(s: string, end: number): [number, number] {
  if (end <= 0) return [-1, 0];
  const c = s.charCodeAt(end - 1);
  if ((c & 0xfc00) === 0xdc00 && end >= 2 && (s.charCodeAt(end - 2) & 0xfc00) === 0xd800) {
    return [s.codePointAt(end - 2)!, 2];
  }
  return [c, 1];
}

const LETTER = /^\p{L}$/u;
const UPPER = /^\p{Lu}$/u;
const DIGIT = /^\p{Nd}$/u;
const HAN = /^\p{Script=Han}$/u;
const PUNCT = /^\p{P}$/u;
const SPACE_CP = /^\p{White_Space}$/u;

export const isLetterCp = (cp: number): boolean => cp >= 0 && LETTER.test(String.fromCodePoint(cp));
export const isUpperCp = (cp: number): boolean => cp >= 0 && UPPER.test(String.fromCodePoint(cp));
export const isDigitCp = (cp: number): boolean => cp >= 0 && DIGIT.test(String.fromCodePoint(cp));
export const isHanCp = (cp: number): boolean => cp >= 0 && HAN.test(String.fromCodePoint(cp));
export const isPunctCp = (cp: number): boolean => cp >= 0 && PUNCT.test(String.fromCodePoint(cp));
export const isSpaceCp = (cp: number): boolean => cp >= 0 && SPACE_CP.test(String.fromCodePoint(cp));

export const hasLetter = (v: string): boolean => /\p{L}/u.test(v);
export const hasUpper = (v: string): boolean => /\p{Lu}/u.test(v);

/** s 中 ASCII 字符串 w 之后是否为 word 的结尾：s 以 w 结尾，且 w 前面不是 word 字符。 */
export function wordEnd(s: string, w: string): boolean {
  return s.endsWith(w) && (s.length === w.length || !isWordCode(s.charCodeAt(s.length - w.length - 1)));
}

/**
 * 同一段文本上的惰性索引。magpie 在 Go 里用 `strings.LastIndexByte(s[:a], '\n')` 找行首，
 * 每次 O(行长)；已知值在一行很长的文本里出现很多次时会退化成平方（#4766 的同类问题）。
 * 这里一次建好换行位置表，之后行首/行尾都是二分。
 */
export class TextCtx {
  private nl: number[] | null = null;
  private lowerCache: string | null = null;

  constructor(readonly s: string) {}

  private newlines(): number[] {
    if (!this.nl) {
      const out: number[] = [];
      for (let i = this.s.indexOf("\n"); i >= 0; i = this.s.indexOf("\n", i + 1)) out.push(i);
      this.nl = out;
    }
    return this.nl;
  }

  /** 严格在 a 之前的最后一个换行之后的位置（Go `LastIndexByte(s[:a], '\n') + 1`）。 */
  lineStart(a: number): number {
    const nl = this.newlines();
    let lo = 0;
    let hi = nl.length; // 第一个 >= a 的下标
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid]! < a) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? 0 : nl[lo - 1]! + 1;
  }

  /** 位置 b 及之后第一个换行的下标，没有则为 s.length。 */
  lineEnd(b: number): number {
    const nl = this.newlines();
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid]! < b) lo = mid + 1;
      else hi = mid;
    }
    return lo === nl.length ? this.s.length : nl[lo]!;
  }

  /** 整段文本的小写（hostIn 用，避免每个人名结果都重新小写一遍）。 */
  get lower(): string {
    return (this.lowerCache ??= this.s.toLowerCase());
  }

  /** thingname.ts 的整文缓存：其它条目都像“应用”的列表行的行首；整段文本是否只有首字母大写的词。 */
  thingLines: number[] | null = null;
  namesOnly: boolean | null = null;
}
