// 移植自 magpie internal/redact/ids.go 的 noIDs，以及 redact.go 的 noNumbers。
// 它们在 magpie 里对所有找到的区间做最后一遍剔除（规则的、模型的、已知值的）；这里只对模型和已知值用。
//
// 后端生成的 id（UUID、32 位以上的十六进制：行 id、请求 id、会话 id、提交哈希）原样放行：
// 对话模型要读它、匹配它、写回工具调用，后端按它的每个字符查找，遮掉一截或整个都会查不到或查错。
// id 的一部分从来不是独立的值（手机号规则曾在 …-a13800138000 末尾找到 13800138000）。
// 整个 id 只在名为凭据的字段里才遮（password=、api_key:、"refresh_token":）。

import type { Kind, Span } from "./types.ts";
import { isWordCode, wordAt } from "./text.ts";

export const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Finder = "model" | "known";

const hexOrHyphen = (c: number): boolean => c === 45 || (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);

/**
 * s[a:b] 是元素令牌，或它快照的那一段（s0000002a，密钥规则的值止于冒号处）：s 加 8 位小写十六进制，
 * 冒号和下标，两侧没有字母数字下划线。没有下标时只有 element_token 字段的值才算。
 * cua-driver 做的令牌，模型靠它点击，被遮了就是点到空处（#3782）。
 */
export function elementToken(s: string, a: number, b: number): boolean {
  if (b - a < 9 || s[a] !== "s" || (a > 0 && wordAt(s, a - 1))) return false;
  for (let i = a + 1; i < a + 9; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  let end = a + 9;
  if (end < s.length && s[end] === ":") {
    let i = end + 1;
    while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
    if (i === end + 1) return false; // 有冒号没下标
    end = i;
  }
  if ((b !== a + 9 && b !== end) || (end < s.length && wordAt(s, end))) return false;
  return end > a + 9 || elementField(fieldWords(s, a));
}

/** 字段名的词恰好是 element token（element_token、element-token）；element_api_key 之类仍是凭据。 */
function elementField(words: string[]): boolean {
  return words.length === 2 && words[0] === "element" && words[1] === "token";
}

/** v 是 UUID、32 位以上不带连字符的十六进制，或较短的摘要。 */
function idShaped(v: string): boolean {
  return uuidRe.test(v) || (v.length >= 32 && !v.includes("-") && /^[0-9a-fA-F]+$/.test(v)) || digestShaped(v);
}

/**
 * v 是不足 32 位的哈希十六进制：16 到 31 位、同一大小写、字母数字都有（短提交、64 位哈希、
 * 截断的 sha256）。以它为键的数据曾被遮成 {{SECRET_…}}，手机号的形状落在其中就成了半个占位符
 * （_kaichen on X, 10-28）。纯数字是号码、卡号或手机号。
 */
function digestShaped(v: string): boolean {
  if (v.length < 16 || v.length >= 32) return false;
  let lower = 0;
  let upper = 0;
  let digits = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c >= 97 && c <= 102) lower++;
    else if (c >= 65 && c <= 70) upper++;
    else return false;
  }
  // 哈希的数字是随机的：16 位里约 6 个字母 10 个数字。数字里夹两个字母是 IBAN（DE89370400…）或编码。
  const letters = lower + upper;
  const floor = Math.max(3, Math.floor(v.length / 8));
  return (lower === 0 || upper === 0) && letters >= floor && digits >= floor;
}

/**
 * s[a:b] 周围的 id：围绕它的十六进制+连字符连续段，当这段是 UUID 或 32 位以上十六进制时；
 * 是元素令牌时就是 s[a:b] 本身。s[a:b] 超出这样的段时 ok 为 false。
 */
function idAround(s: string, a: number, b: number): { l: number; r: number } | null {
  if (elementToken(s, a, b)) return { l: a, r: b };
  let l = a;
  let r = b;
  while (l > 0 && hexOrHyphen(s.charCodeAt(l - 1))) l--;
  while (r < s.length && hexOrHyphen(s.charCodeAt(r))) r++;
  while (l < r && s[l] === "-") l++;
  while (r > l && s[r - 1] === "-") r--;
  if (a < l || b > r || /[^0-9a-fA-F-]/.test(s.slice(l, r)) || !idShaped(s.slice(l, r))) return null;
  // 短摘要是独立的词，不是更长串的十六进制尾巴（密钥 sk_…deadbeef…）
  if (digestShaped(s.slice(l, r)) && ((l > 0 && wordAt(s, l - 1)) || (r < s.length && wordAt(s, r)))) return null;
  return { l, r };
}

/** s[l:r] 是字段名而不是字段值：JSON 对象的键（{"5d41402abc4b2a76": {…}}），以哈希为键的数据。名字从来不是密钥。 */
function nameOfField(s: string, l: number, r: number): boolean {
  if (l === 0 || s[l - 1] !== '"') return false;
  let i = r;
  if (i < s.length && s[i] === "\\") i++;
  if (i >= s.length || s[i] !== '"') return false;
  i++;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i < s.length && s[i] === ":";
}

/** 字段名的词（小写）：next_page_token、nextPageToken、X-Next-Page-Token 都是 next、page、token。 */
function nameWords(name: string): string[] {
  const out: string[] = [];
  let w = "";
  const flush = () => {
    if (w !== "") out.push(w);
    w = "";
  };
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (c === "_" || c === "-" || c === ".") flush();
    else if (c >= "A" && c <= "Z") {
      if (i > 0 && name[i - 1]! >= "a" && name[i - 1]! <= "z") flush();
      w += c.toLowerCase();
    } else w += c;
  }
  flush();
  return out;
}

/** 值从 s[at] 起的那个字段的名字的词；前面没有字段名则为空。 */
export function fieldWords(s: string, at: number): string[] {
  const skip = " \t\"'\\";
  let i = at;
  while (i > 0 && skip.includes(s[i - 1]!)) i--;
  if (i === 0 || (s[i - 1] !== ":" && s[i - 1] !== "=")) return [];
  i--;
  while (i > 0 && skip.includes(s[i - 1]!)) i--;
  let j = i;
  while (j > 0 && (isWordCode(s.charCodeAt(j - 1)) || s[j - 1] === "." || s[j - 1] === "-")) j--;
  return nameWords(s.slice(j, i));
}

/** 裸的 key 的值从 s[at] 起，且它是凭据名的后半（api key、access key、secret key、private key）。 */
function keyPhrase(s: string, at: number): boolean {
  const before0 = s.slice(Math.max(0, at - 24), at).toLowerCase();
  const i = before0.lastIndexOf("key");
  if (i < 0) return false;
  const before = before0.slice(0, i).replace(/ +$/, "");
  for (const w of ["api", "access", "secret", "private", "signing", "license", "licence"]) {
    if (before.endsWith(w) && (before.length === w.length || !isWordCode(before.charCodeAt(before.length - w.length - 1)))) return true;
  }
  return false;
}

/**
 * 值从 s[at] 起的字段是凭据名：refresh_token、DB_PASSWORD、x-api-key；
 * 不算名为 id、游标、请求、element_token 的，也不算裸的 key。
 */
function credentialField(s: string, at: number): boolean {
  const words = fieldWords(s, at);
  if (words.length === 1 && words[0] === "key" && keyPhrase(s, at)) return true; // api key: …、Secret Key = …
  if ((words.length < 2 && (words.length === 0 || words[0] === "key")) || elementField(words)) return false;
  switch (words[words.length - 1]) {
    case "id":
    case "ids":
    case "uuid":
    case "guid":
      return false;
  }
  for (const w of words) {
    switch (w) {
      case "page": case "next": case "cursor": case "continuation": case "csrf": case "xsrf": case "trace":
      case "request": case "idempotency": case "sync": case "nonce":
      case "hash": case "digest": case "checksum": case "sha": case "fingerprint": case "etag":
      // 用来找数据、不是用来进门的 key：cache_key、cacheKey、object_key、dedupe_key
      case "cache": case "commit": case "object": case "blob": case "file": case "content": case "revision":
      case "rev": case "partition": case "shard": case "bucket": case "dedup": case "dedupe": case "lookup":
      case "row": case "sort":
        return false;
    }
  }
  return true;
}

/**
 * 去掉 id 内部的区间。by="known"：以前整体遮过的是凭据，只有元素令牌放行（散文里被模型标过的
 * “click s00000001” 否则会让之后每个 element_token 都变成点到空处）。by="model"：模型在散文里找到
 * 的 32 位十六进制它叫密钥（“the api key is 9f8e…”）；UUID、元素令牌、名字不是凭据的字段的值，
 * 以及字段名本身都放行。
 */
export function noIDs(s: string, spans: Span[], by: Finder): Span[] {
  return spans.filter((f) => {
    const id = idAround(s, f.start, f.end);
    if (!id) return true;
    const { l, r } = id;
    if (f.start > l || f.end < r) return false; // id 的一截
    if (by === "known") return !elementToken(s, l, r);
    return !(
      f.kind !== "SECRET" ||
      uuidRe.test(s.slice(l, r)) ||
      elementToken(s, l, r) ||
      (fieldWords(s, l).length > 0 && !credentialField(s, l)) ||
      nameOfField(s, l, r)
    );
  });
}

/** s[a:b] 开头的数字是小数的小数部分，或结尾的数字是整数部分（点前后都是数字）。 */
function inDecimal(s: string, a: number, b: number): boolean {
  const isDigit = (i: number): boolean => i >= 0 && i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57;
  return (isDigit(a) && a >= 2 && s[a - 1] === "." && isDigit(a - 2)) || (isDigit(b - 1) && b + 1 < s.length && s[b] === "." && isDigit(b + 1));
}

/**
 * s[a:b] 是一个完整的裸 JSON 数字，按位置判断：只有数字、是对象的值（"key": …）或数字数组的元素，
 * 后面只有结束这个值的 , } ]。"phone": "13800138000" 是字符串，phone:13800138000 和
 * "call 13800138000, thanks" 是文本，所以仍要遮。
 */
function jsonNumber(s: string, a: number, b: number): boolean {
  if (a >= b || !/^[0-9]+$/.test(s.slice(a, b))) return false;
  const space = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  let k = b;
  while (k < s.length && space(s[k]!)) k++;
  if (k < s.length && !",}]".includes(s[k]!)) return false;
  let i = a - 1;
  while (i >= 0 && space(s[i]!)) i--;
  if (i < 0) return false;
  switch (s[i]) {
    case ":":
      for (i--; i >= 0 && space(s[i]!); i--);
      return i >= 0 && s[i] === '"';
    case "[":
    case ",":
      // 往回越过前面的数字，到数组的 [
      for (; i >= 0; i--) {
        if (s[i] === "[") return true;
        if (!"0123456789,.-+eE".includes(s[i]!) && !space(s[i]!)) return false;
      }
  }
  return false;
}

const PERSONAL: ReadonlySet<Kind> = new Set<Kind>(["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT"]);

/**
 * 去掉是小数的一部分的区间：5.13800138000 点后的数字、13800138000.5 点前的数字。数要整个地判断，
 * 高度、价格、坐标的小数位恰好校验通过，也不是手机号或卡号（willz on Discord）。裸 JSON 数字
 * （"timestamp": 17929036837）是计数或时间；JSON 里的手机号、卡号是字符串。只管个人信息类别：
 * 密钥在哪儿都遮。
 */
export function noNumbers(s: string, spans: Span[]): Span[] {
  return spans.filter((f) => !(PERSONAL.has(f.kind) && (inDecimal(s, f.start, f.end) || jsonNumber(s, f.start, f.end))));
}
