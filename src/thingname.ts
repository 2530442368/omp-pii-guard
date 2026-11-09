// 移植自 magpie internal/redact/thingname.go。
//
// App 或产品名常常是一个首字母大写的词：Cicada、Mimi、Phosphor、Parakeet、Muesli。周围什么也没有、
// 或在列表里、或在每行一个的 Markdown 应用清单里，模型会把每个都当成人名，而对话模型随后拿另一个
// 应用的事实来回答（ylorn. on Discord, 11-06：历史里是占位符，后面的问题里却是原文，没有任何东西
// 说哪个占位符是哪个应用）。
//
// 模型当成人名的一个单词，在周围的话说它是物、且没有话说它是人时，原样放行：
//   - 它前后的词：人的（my colleague Mimi、Hi Mimi、Mimi said、Mimi's Mac、张伟先生）或物的
//     （using Phosphor、switched to Muesli、the Phosphor app、Parakeet 这个软件）；
//   - 否则看它的句子：代词、亲属关系、称谓、说话词、问候说是人，就遮；
//   - 否则是一个列表项，其他项说的是应用；或整段文本只有两个以上这样的词（Cicada, Mimi, Phosphor），
//     是一串名字、没有话说是谁的，原样放行。
//
// 句子里别处出现的应用词不说明这个名字：“Rina uses Windows at home”“Rina's Mac won't boot”
// 放行的话，一个人的名字就和系统名一起发出去了。单独成文的词（“Rina”、工具参数 {"recipient":"Rina"}）
// 也不说明什么，工具调用参数里一律不走这条（personFits 的 args）。
//
// 放行的是：一串名字里的名、紧挨着应用词的名。两个词以上的名字（John Smith）、句子里有
// he/she/said/问候/亲属关系的名字、所有中文名，照旧遮。

import type { TextCtx } from "./text.ts";
import { trimLeftSet, trimRightSet } from "./text.ts";
import { endsAny, startsAny, zhRoles, zhTitles } from "./zhname.ts";

function wordSet(...ws: string[]): ReadonlySet<string> {
  return new Set(ws);
}

const articles = wordSet("the", "a", "an");
const listJoins = wordSet("and", "or", "vs", "versus", "nor");

/** 它们紧挨着的名字是人的。 */
const nameBefore = wordSet(
  "colleague", "coworker", "co-worker", "teammate", "friend", "boss", "manager", "wife", "husband",
  "mom", "mum", "dad", "mother", "father", "son", "daughter", "brother", "sister", "aunt", "uncle", "cousin",
  "grandma", "grandpa", "boyfriend", "girlfriend", "fiance", "fiancee", "teacher", "student", "client", "customer",
  "mr", "mrs", "ms", "miss", "dr", "prof", "dear", "hi", "hello", "hey", "thanks", "thank", "cc", "ask", "tell",
  "told", "asked", "email", "emailed", "call", "called", "text", "texted", "meet", "met", "named", "by",
);
const nameAfter = wordSet(
  "said", "says", "told", "tells", "asked", "asks", "wrote", "writes", "replied", "thinks", "thought",
  "wants", "wanted", "likes", "liked", "loves", "prefers", "recommends", "recommended", "suggested", "mentioned",
  "emailed", "texted", "called", "messaged", "lives", "works", "worked", "jr", "sr",
);

/** 它们紧挨着的名字是物的。两边都可能的词（Mimi has、sync with Mimi、I like Mimi）留给整句判断。 */
const thingBefore = wordSet(
  "use", "uses", "using", "used", "install", "installed", "installing", "uninstall", "download",
  "downloaded", "downloading", "open", "opened", "launch", "launched", "buy", "bought", "try", "tried", "trying",
  "app", "apps", "tool", "tools", "vs", "versus",
);
const thingVerbs = wordSet(
  "switch", "switched", "switching", "move", "moved", "moving", "migrate", "migrated", "migrating",
  "upgrade", "upgraded", "compare", "compared", "comparing", "import", "imported", "export", "exported",
);
const thingAfter = wordSet(
  "app", "apps", "application", "beta", "pro", "plus", "premium", "vs", "versus", "supports",
  "syncs", "costs", "lets", "offers", "runs", "crashes", "crashed", "integrates", "exports", "imports",
);
/** like/called/named 之前的这些词让后面的名字成为物：apps like Cicada、an app called Mimi。 */
const thingKinds = wordSet(
  "app", "apps", "application", "applications", "tool", "tools", "software", "editors", "clients",
  "plugin", "plugins", "extension", "extensions", "alternatives", "options",
);

/** 名字所在的句子里有这些词，说明指的是人。 */
const personWords = wordSet(
  "he", "she", "him", "her", "his", "hers", "himself", "herself",
  "colleague", "colleagues", "coworker", "teammate", "friend", "boss", "manager", "wife", "husband", "mom", "mum",
  "dad", "mother", "father", "son", "daughter", "brother", "sister", "boyfriend", "girlfriend", "teacher",
  "client", "customer", "mr", "mrs", "ms", "dr", "dear", "hi", "hello", "hey", "thanks", "regards", "cc",
  "said", "says", "told", "tells", "asked", "emailed", "texted", "birthday", "married",
);
/** 列表里其他项有这些词，说明列表项是物。 */
const thingWords = wordSet(
  "app", "apps", "application", "applications", "software", "tool", "tools", "utility", "utilities",
  "plugin", "plugins", "extension", "extensions", "launcher", "widget", "widgets",
  "macos", "ios", "ipados", "android", "mac", "iphone", "ipad", "windows", "linux", "download",
  "install", "installed", "pricing", "subscription", "one-time", "trial", "license",
  "open-source", "features", "alternative", "alternatives", "vs", "versus", "icloud", "reader", "player",
  "browser", "note-taking", "markdown", "rss",
);
/** 中文的同类词，在文本里直接找（没有空格）。 */
const zhPersonWords = ["他", "她", "同事", "朋友", "老板", "先生", "女士", "老师", "说", "告诉"];
const zhThingAfter = ["这个软件", "这个应用", "这个工具", "这款", "应用", "软件", "客户端", "插件"];

/** s[a:b] 这个被模型当成人名的单词，在那里指的是物。 */
export function thingNamed(s: string, a: number, b: number, ctx: TextCtx): boolean {
  const t = trimLeftSet(s.slice(b), "*_`\"'”)");
  if (t.startsWith("'s") || t.startsWith("’s")) {
    // 所有格是人的（Rina's Mac won't boot）
    return false;
  }
  const [cs, ce] = clauseAround(s, a, b);
  const [prev, prev2] = wordsBefore(s.slice(cs, a));
  const next = latinAfter(s.slice(b, ce));
  const afterTrim = trimLeftSet(s.slice(b, ce), " ");
  if ((prev === "like" || prev === "called" || prev === "named") && thingKinds.has(prev2)) return true;
  if (nameBefore.has(prev) || nameAfter.has(next) || endsAny(trimRightSet(s.slice(cs, a), " "), zhRoles, true) || startsAny(afterTrim, zhTitles)) {
    return false;
  }
  if (
    thingBefore.has(prev) ||
    ((prev === "to" || prev === "from" || prev === "with" || prev === "over") && thingVerbs.has(prev2)) ||
    thingAfter.has(next) ||
    startsAny(afterTrim, zhThingAfter)
  ) {
    return true;
  }
  const clause = (s.slice(cs, a) + " " + s.slice(b, ce)).toLowerCase();
  if (hasWord(clause, personWords) || zhPersonWords.some((w) => clause.includes(w))) return false;
  return listOfThings(s, a, ctx) || namesOnly(s, ctx);
}

/**
 * s[a:] 的名字是一个列表项的开头，列表里其他项说的是物：
 * “1. **Cicada** – a minimal note-taking app” 之下的 “3. **Phosphor** – an RSS reader”。
 * magpie 对每个单词人名都逐行扫整段文本；这里整段只扫一次，记下“说物”的行首。
 */
function listOfThings(s: string, a: number, ctx: TextCtx): boolean {
  const ls = ctx.lineStart(a);
  if (!listItem(s.slice(ls, a))) return false;
  if (!ctx.thingLines) {
    const lines: number[] = [];
    for (let start = 0; start < s.length; ) {
      let end = s.indexOf("\n", start);
      if (end < 0) end = s.length;
      const t = trimLeftSet(s.slice(start, end), " \t");
      const i = listMarker(t);
      if (i > 0) {
        const l = t.slice(i).toLowerCase();
        if (hasWord(l, thingWords) && !hasWord(l, personWords)) lines.push(start);
      }
      start = end + 1;
    }
    ctx.thingLines = lines;
  }
  return ctx.thingLines.some((start) => start !== ls);
}

/** before（一行开头到名字）只有列表标记和标记语法：“1. **”、“- ”、“* ”。 */
function listItem(before: string): boolean {
  const t = trimLeftSet(before, " \t");
  const i = listMarker(t);
  return i > 0 && trimLeftSet(trimRightSet(t.slice(i), " *_`"), " *_`") === "";
}

/** t 开头的列表标记连同后面空格的长度（1. 、2) 、- 、* 、• ），没有则为 0。 */
function listMarker(t: string): number {
  let i = 0;
  while (i < t.length && t.charCodeAt(i) >= 48 && t.charCodeAt(i) <= 57) i++;
  if (i > 0 && i < t.length && (t[i] === "." || t[i] === ")")) i++;
  else if (i === 0 && (t.startsWith("- ") || t.startsWith("* "))) i = 1;
  else if (i === 0 && t.startsWith("• ")) i = 1;
  else return 0;
  return i < t.length && t[i] === " " ? i + 1 : 0;
}

/**
 * s[a:b] 所在的句子：从上一句结束（句号加空格、?、!、;、行尾、。！？；）之后，到自己这句结束。
 */
function clauseAround(s: string, a: number, b: number): [number, number] {
  let cs = 0;
  for (let i = a - 1; i >= 0; i--) {
    const c = s[i]!;
    if (c === "\n" || c === "?" || c === "!" || c === ";" || (c === "." && i + 1 < s.length && s[i + 1] === " ") || "。！？；".includes(c)) {
      cs = i + 1;
      break;
    }
  }
  let ce = s.length;
  for (let i = b; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\n" || c === "?" || c === "!" || c === ";" || (c === "." && (i + 1 === s.length || s[i + 1] === " ")) || "。！？；".includes(c)) {
      ce = i;
      break;
    }
  }
  return [cs, ce];
}

/** s 里的拉丁词，小写、按顺序。非 ASCII 字符都是分隔。 */
function latinWords(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9\-']+/).filter((w) => w !== "");
}

/**
 * before 的最后一个词和它前面一个，去掉冠词（the Phosphor app、install the Cicada beta）。
 * 名字紧前面是中文字或空格与标记以外的东西，就没有词：“说 Parakeet” 之前没有拉丁词。
 */
function wordsBefore(before: string): [string, string] {
  const t = trimRightSet(before, " \t*_`\"'“(");
  if (t === "" || !/[A-Za-z0-9]$/.test(t)) return ["", ""];
  const ws = latinWords(t);
  while (ws.length > 0 && articles.has(ws[ws.length - 1]!)) ws.pop();
  switch (ws.length) {
    case 0:
      return ["", ""];
    case 1:
      return [ws[0]!, ""];
  }
  return [ws[ws.length - 1]!, ws[ws.length - 2]!];
}

/**
 * after 的第一个词，越过空格和标记：“Phosphor app” 里的 app、“Mimi said” 里的 said。
 * 中间的逗号或破折号说明不了名字（“Cicada, Mimi” 是列表里的两项）。
 */
function latinAfter(after: string): string {
  const t = trimLeftSet(after, " \t*_`\"'”)");
  if (t.startsWith("'s ") || t.startsWith("’s ")) return "";
  if (t === "" || !/^[A-Za-z]/.test(t)) return "";
  const ws = latinWords(t);
  return ws.length > 0 ? ws[0]! : "";
}

/** s 的拉丁词里有 set 里的。 */
function hasWord(s: string, set: ReadonlySet<string>): boolean {
  return latinWords(s).some((w) => set.has(w.endsWith("'s") ? w.slice(0, -2) : w));
}

/**
 * s 只有首字母大写的词、词间的 and/or 和标记：“Cicada, Mimi, Phosphor, Parakeet, Muesli”、
 * “Muesli”、“Cicada 和 Mimi”。整段只算一次。
 */
function namesOnly(s: string, ctx: TextCtx): boolean {
  if (ctx.namesOnly !== null) return ctx.namesOnly;
  let t = s;
  for (const c of ["和", "或", "、", "，", "与", "跟"]) t = t.split(c).join(" ");
  let n = 0;
  let ok = true;
  // 按 ASCII 里不是字母数字和撇号的字符切开；非 ASCII 字符留在词里
  for (const w of t.split(/[^A-Za-z0-9'\u0080-\uffff]+/)) {
    if (w === "") continue;
    if (listJoins.has(w.toLowerCase())) continue;
    if (/[^\x00-\x7f]/.test(w) || !/^[A-Z]/.test(w)) {
      ok = false;
      break;
    }
    n++;
  }
  return (ctx.namesOnly = ok && n >= 2 && n <= 20);
}
