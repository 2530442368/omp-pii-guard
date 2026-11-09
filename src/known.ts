// 移植自 magpie internal/redact/known.go 的 knownSpans。
//
// 遮过一次的值，在请求里别的位置也照遮，不管它周围是什么。规则靠周围的东西找值（DB_PASSWORD=、
// 邮箱的边界），而供应商用自己的话回答占位符：“the password is {{SECRET_…}}”“write to {{EMAIL_…}}.”，
// 智能体读到的是还原后的值，下一轮它又出现在历史里，那里没有任何规则能匹配。按“已知值”匹配它，
// 它就再次变成同一个占位符。
//
// 与 magpie 的差别：
//   - magpie 的已知值表是进程级全局状态，这里由调用方传入：值 → 类别。所有传入的值都当作“只有模型找到过”
//     （magpie 里按分数区分，规则找到的值不受阈值和 wordsOnly 约束）：阈值由调用方在放入前把关，
//     全小写词组成的 SECRET 只在被赋给密钥的名字时才再次遮（assignedSecret）。
//   - magpie 对每个位置先用 4 字节哈希位图过一遍再按前 8 字节查表，已知值很多时仍是每个候选线性比较。
//     这里改成对所有已知值建一棵字典树，在文本上逐位置沿树走：总代价与文本长度加命中数成正比，
//     与已知值的个数无关。树按“传入的 Map 的内容”缓存，内容不变就不重建。
//   - 判断一个命中的位置（packageAt）只读该位置的行和前后固定窗口，不读整段文本：
//     见 packages.ts 与 text.ts 的 TextCtx（#4766 的教训：长会话里每个已遮值出现一次就重读整段，504）。
//   - magpie 的 standsAlone 对 BANK_CARD/ID_CARD/IP/MAC/USERNAME 等规则类别有专门分支，本扩展的类别里没有，
//     只保留 PHONE、EMAIL 和默认三条。

import type { Kind, Span } from "./types.ts";
import { noIDs, noNumbers } from "./ids.ts";
import { assignedSecret, wordsOnly } from "./filters.ts";
import { packageAt } from "./packages.ts";
import { TextCtx, byteLen } from "./text.ts";
import { zhWordNotName } from "./zhname.ts";

/**
 * 能作为已知值匹配的最短长度（UTF-8 字节，同 magpie）。更短的（URL 里三个字母的密码）会在普通文本里
 * 到处出现；8 是“赋值里的密码”规则对值的要求。
 */
export const MIN_KNOWN = 8;

/**
 * 与 magpie 的差别（隐私优先，用户选择 fail-closed）：PERSON 类、由 2–4 个汉字组成的已知值（张伟）豁免 MIN_KNOWN，
 * 照样参与补遮——两字中文名只有 6 字节，否则模型在别处低分漏掉它时就漏遮。新纳入的（不足 MIN_KNOWN 字节的）
 * 名字与普通词同形时，在没有角色词/称谓的语境里不补遮（zhWordNotName）；已经够长的（3–4 字）保持 magpie 原样：
 * 与词同形也照遮（白名单）。调用方放入前已按阈值把关。
 */
const SHORT_HAN_NAME = /^\p{Script=Han}{2,4}$/u;
const shortName = (v: string, kind: Kind): boolean => kind === "PERSON" && SHORT_HAN_NAME.test(v);

interface Index {
  /** 根节点：码元 → 子节点号（0 表示没有）。 */
  root: Int32Array;
  /** 其余节点：节点号 → (码元 → 子节点号)。 */
  next: Map<number, number>[];
  /** 节点号 → 在这里结束的已知值（没有则为 undefined）。 */
  term: ({ v: string; kind: Kind } | undefined)[];
}

function build(known: ReadonlyMap<string, Kind>): Index {
  const idx: Index = { root: new Int32Array(65536), next: [new Map()], term: [undefined] };
  for (const [v, kind] of known) {
    if (byteLen(v) < MIN_KNOWN && !shortName(v, kind)) continue;
    let node = idx.root[v.charCodeAt(0)]!;
    if (node === 0) {
      node = idx.next.length;
      idx.next.push(new Map());
      idx.term.push(undefined);
      idx.root[v.charCodeAt(0)] = node;
    }
    for (let i = 1; i < v.length; i++) {
      const c = v.charCodeAt(i);
      let child = idx.next[node]!.get(c);
      if (child === undefined) {
        child = idx.next.length;
        idx.next.push(new Map());
        idx.term.push(undefined);
        idx.next[node]!.set(c, child);
      }
      node = child;
    }
    idx.term[node] = { v, kind };
  }
  return idx;
}

/** 按传入 Map 缓存字典树：条目（键、类别、顺序）完全一致时复用，否则重建。 */
const cache = new WeakMap<ReadonlyMap<string, Kind>, { keys: string[]; kinds: Kind[]; index: Index }>();

function indexFor(known: ReadonlyMap<string, Kind>): Index {
  const hit = cache.get(known);
  if (hit && hit.keys.length === known.size) {
    let same = true;
    let i = 0;
    for (const [k, kind] of known) {
      if (hit.keys[i] !== k || hit.kinds[i] !== kind) {
        same = false;
        break;
      }
      i++;
    }
    if (same) return hit.index;
  }
  const index = build(known);
  cache.set(known, { keys: [...known.keys()], kinds: [...known.values()], index });
  return index;
}

const isAlnum = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * s[a:b] 就是那个已知值本身，不是更长值的一截：号码两侧不能有字母数字（9f13800138000abc 是哈希的一截）；
 * 邮箱不能是更长地址的一部分（句号可以结束它后面的句子）；密钥两侧不能紧贴字母数字
 * （用户规则找到的十二位十六进制也在哈希中间）。
 */
function standsAlone(kind: Kind, s: string, a: number, b: number): boolean {
  const before = a > 0 ? s.charCodeAt(a - 1) : -1;
  const after = b < s.length ? s.charCodeAt(b) : -1;
  const inSet = (c: number, extra: string): boolean => c >= 0 && (isAlnum(c) || extra.includes(String.fromCharCode(c)));
  switch (kind) {
    case "PHONE":
      return !inSet(before, "") && !inSet(after, "");
    case "EMAIL":
      if (inSet(before, "._%+-") || inSet(after, "_%+")) return false;
      // a.b@c.com.cn 是另一个地址；a.b@c.com. 是句子的结尾
      return !inSet(after, ".-") || b + 1 >= s.length || !isAlnum(s.charCodeAt(b + 1));
  }
  return !(isAlnum(before) && isAlnum(s.charCodeAt(a))) && !(isAlnum(after) && isAlnum(s.charCodeAt(b - 1)));
}

/**
 * s 里有已知值的地方。同一位置有几个已知值时取最长的有效者；不重叠；按起点排序。
 * known 是值 → 类别；类别过滤由调用方在放入前完成。
 */
export function knownSpans(s: string, known: ReadonlyMap<string, Kind>): Span[] {
  if (known.size === 0 || s.length === 0) return [];
  const idx = indexFor(known);
  let ctx: TextCtx | undefined;
  const out: Span[] = [];
  const hits: { v: string; kind: Kind }[] = [];
  for (let i = 0; i < s.length; i++) {
    const c0 = s.charCodeAt(i);
    // 不从代理对中间开始（值以落单代理开头时才可能走到这里）
    if (c0 >= 0xdc00 && c0 <= 0xdfff && i > 0) {
      const p = s.charCodeAt(i - 1);
      if (p >= 0xd800 && p <= 0xdbff) continue;
    }
    let node = idx.root[c0]!;
    if (node === 0) continue;
    hits.length = 0;
    for (let j = i; ; ) {
      const t = idx.term[node];
      if (t) hits.push(t);
      if (++j >= s.length) break;
      const nx = idx.next[node]!.get(s.charCodeAt(j));
      if (nx === undefined) break;
      node = nx;
    }
    for (let h = hits.length - 1; h >= 0; h--) {
      const { v, kind } = hits[h]!;
      const end = i + v.length;
      // 也不在代理对中间结束
      if (end < s.length) {
        const l = s.charCodeAt(end - 1);
        const n = s.charCodeAt(end);
        if (l >= 0xd800 && l <= 0xdbff && n >= 0xdc00 && n <= 0xdfff) continue;
      }
      // 只有模型找到的、全由小写词组成的“密钥”（drizzle-orm）：只在被赋给密钥的名字时才再遮
      // （dniray on Discord, v0.1.1976）
      if (kind === "SECRET" && wordsOnly(v) && !assignedSecret(s, i)) continue;
      if (shortName(v, kind) && byteLen(v) < MIN_KNOWN && zhWordNotName(s, i, end)) continue;
      if (!standsAlone(kind, s, i, end)) continue;
      // 代码加载的模块、清单的依赖：之前遮它的是把包名当成了密钥（dniray, v0.1.1965）
      if (packageAt(s, i, end, (ctx ??= new TextCtx(s)))) continue;
      out.push({ start: i, end, kind });
      i = end - 1;
      break;
    }
  }
  return noNumbers(s, noIDs(s, out, "known"));
}
