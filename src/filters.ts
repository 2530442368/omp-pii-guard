// 移植自 magpie internal/redact/model.go：把本地模型（AstrLink Guard）的原始结果过滤成要遮的区间。
//
// 链路：AstrLink 标签 → magpie 的 guardLabels → modelKinds（url/ip_address/private_date 丢弃）→
// 阈值 → 去空白与分隔符修边（zhTrim）→ modelTakes（值本身像不像）→ modelFits（所在位置像不像）→
// zhWordNotName → 中文名补找（zhNameSpans）→ noIDs/noNumbers（id、小数、裸 JSON 数字）→
// allow 与重叠消解（magpie 的 apply）。
//
// 偏移一律是 JS 字符串下标（UTF-16）。magpie 是 Go 字节下标；按字节判断 ASCII 的地方改成按字符，
// `utf8.ValidString` 改成“不切开代理对、没有落单代理”，“值前 40/64 字节”的窗口改按码元计。
// 密钥最短 8、数字占比这类按 `len(v)` 的长度判断仍按 UTF-8 字节数，行为同 magpie。

import type { Kind, ModelOptions, RawFind, Span } from "./types.ts";
import { realEmail } from "./email.ts";
import { noIDs, noNumbers, uuidRe } from "./ids.ts";
import { packageAt } from "./packages.ts";
import { thingNamed } from "./thingname.ts";
import { zhNameSpans, zhTrim, zhWordNotName } from "./zhname.ts";
import {
  TextCtx,
  allDigits,
  byteLen,
  countDigits,
  fields,
  hasLetter,
  hasUpper,
  isASCII,
  isLetterCp,
  isSpace,
  isWordCode,
  runeCount,
  trimRightSet,
  wordAt,
} from "./text.ts";

export type { Kind, ModelOptions, RawFind, Span };

// ---- 标签映射 ------------------------------------------------------------------------------

/**
 * AstrLink Guard 的标签 → 类别。magpie 先经 guardLabels 换成 Privacy Filter 的名字，再经 modelKinds
 * 换成占位符类别，这里合成一步。url、ip_address、private_date 不遮：请求里的日期几乎都是日志或版本的，
 * URL 是智能体自己的，地址规则没遮的 IP 留给对话模型读。
 */
const modelKinds: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ["private_person", "PERSON"],
  ["private_address", "ADDRESS"],
  ["phone", "PHONE"],
  ["email", "EMAIL"],
  ["account", "ACCOUNT"],
  ["payment_card", "ACCOUNT"],
  ["common_secret", "SECRET"],
]);

// ---- 入口 ----------------------------------------------------------------------------------

/**
 * finds（模型对 text 的原始结果）里要遮的区间：去掉模型连带吃进去的空格（中文名则去掉它顺势写下去的
 * 话，zhTrim），丢弃模型常错的（modelTakes、modelFits），再补上它漏掉的中文名（zhNameSpans）。
 * 结果按起点排序、互不重叠，allow 里的整值不遮，opts.kinds 之外的类别不遮。
 */
export function modelSpans(text: string, finds: readonly RawFind[], opts: ModelOptions): Span[] {
  const ctx = new TextCtx(text);
  const out: Span[] = [];
  for (const f of finds) {
    if (!(f.score >= opts.threshold)) continue; // 低于阈值（含 NaN）
    const kind = modelKinds.get(f.label);
    if (!kind || !opts.kinds.has(kind)) continue;
    if (!Number.isInteger(f.start) || !Number.isInteger(f.end) || f.start < 0 || f.end > text.length || f.start >= f.end) continue;
    let a = f.start;
    let b = f.end;
    if (kind === "SECRET") {
      // 模型把 JSON 的键连值一起吃进来（ledgerId":"gl_Wq7r…），键不是密钥的一部分
      const k = text.slice(a, b).lastIndexOf('":"');
      if (k >= 0) a += k + 3;
    }
    const edge = kind === "SECRET" ? isSpace : delimiter;
    while (a < b && edge(text[a])) a++;
    while (b > a && edge(text[b - 1])) b--;
    if (kind === "PERSON") [a, b] = zhTrim(text, a, b);
    // magpie 的 utf8.ValidString：区间不能切开代理对，也不能含落单代理
    if (a < b && wellFormed(text, a, b)) {
      const v = text.slice(a, b);
      if (modelTakes(kind, v) && modelFits(text, a, b, kind, opts.args, ctx) && !(kind === "PERSON" && zhWordNotName(text, a, b))) {
        out.push({ start: a, end: b, kind });
      }
    }
  }
  if (opts.kinds.has("PERSON")) {
    // magpie 里补找哪些中文名由 Options.NamesByModel 决定：本地模型是 AstrLink Guard 时为 true，
    // 此时只补昵称（小王、老李）。本扩展只用 AstrLink Guard，所以默认 true；false 仅供测试 magpie 的原用例。
    const person = out.filter((f) => f.kind === "PERSON");
    out.push(...zhNameSpans(text, person, opts.namesByModel ?? true));
  }
  return normalizeSpans(text, noNumbers(text, noIDs(text, out, "model")), opts.allow);
}

/**
 * magpie `apply` 里对区间的处理：先开始的先赢，同起点的取长的；允许的整值（去首尾空白后与区间文本
 * 相等，不分大小写，同 magpie `Options.Allow`）原样放行，并让落在它里面开头的区间也放行。
 * 结果按起点排序、互不重叠。
 */
export function normalizeSpans(text: string, spans: readonly Span[], allow: ReadonlySet<string>): Span[] {
  const allowed = new Set<string>();
  for (const a of allow) allowed.add(a.trim().toLowerCase());
  const sorted = spans.slice().sort((x, y) => x.start - y.start || y.end - x.end);
  const out: Span[] = [];
  let next = 0; // 下一个值最早能从哪里起
  let kept = 0; // 被放行的值的结尾
  for (const f of sorted) {
    if (f.start < next || f.start < kept) continue;
    if (allowed.size > 0 && allowed.has(text.slice(f.start, f.end).toLowerCase())) {
      kept = Math.max(kept, f.end);
      continue;
    }
    next = f.end;
    out.push(f);
  }
  return out;
}

/** 区间 [a,b) 不切开代理对、不含落单代理（magpie 的 utf8.ValidString）。 */
function wellFormed(s: string, a: number, b: number): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s.slice(a, b));
}

/**
 * c 可以结束模型的区间，且不是名字、电话、地址或账号的一部分：空格，或 JSON/CSV 里值之间的东西。
 * 模型的区间可能从值前面的那个 token 起：{"phone":"+86 139 …"} 里的电话来成 `":"+86 139 …`，
 * CSV 行里是 `,+81 90-…`，都不是 PHONE 检查认得的号码，于是原样发出（#3591）。
 * 密钥的两端是它自己的（密码可以以引号开头），所以密钥只修空白。
 */
function delimiter(c: string | undefined): boolean {
  return isSpace(c) || (c !== undefined && `"',;:`.includes(c));
}

// ---- 值本身像不像（modelTakes） --------------------------------------------------------------

/**
 * v 能按模型给的类别遮：密钥至少和规则要求的一样长，且不是供应商/工具生成的 id
 * （req_…、toolu_…、call_…，智能体和供应商要拿它去对另一端）；名字至少两个字，不是 snake_case 词。
 * 模型曾把 Codex 的 sequential_cutoff 当名字，供应商按自己的清单校验的值变成占位符：每个请求
 * 400，直到关掉本地模型（#3144）。这样的词是协议的或程序的，在哪儿都是：设置、工具参数、代码。
 */
export function modelTakes(kind: Kind, v: string): boolean {
  if (hexLiteral.test(v)) return false;
  switch (kind) {
    case "SECRET":
      return byteLen(v) >= 8 && !madeID(v) && !namesThing(v) && !versionValue(v);
    case "PERSON":
      // （普通的中文词，文案、关键词，在读到它的地方放行：zhWordNotName）
      return runeCount(v) >= 2 && hasLetter(v) && !snakeWord(v);
    case "ACCOUNT":
      return !madeID(v);
    case "EMAIL":
      // 同规则：文件名（icon@2x.png）、示例不是地址，没有 @ 的主机名（eu.stg.acme.io）、
      // 符号（system@got、foo@@GLIBC_2.2.5）也不是：realEmail 的 mailHost
      return v.includes("@") && realEmail(v);
  }
  return true;
}

/** v 是用下划线连起来的 ASCII 字母数字（sequential_cutoff、list_threads、mcp__codex_app）。 */
export function snakeWord(v: string): boolean {
  if (!v.includes("_") || trimRightSet(v, "_").replace(/^_+/, "") === "") return false;
  return /^[A-Za-z0-9_]+$/.test(v);
}

/**
 * v 是模型当成密钥的东西，其实是给某物命名而不是开锁：UUID（会话的、一轮的、请求的；window_id 的
 * 后面带 :0）、带算法名的摘要（sha256 9b74…）、文件路径。模型把三者都当密钥；Codex 的一轮元数据
 * 的每个 id 都变成了 {{SECRET_…}}（#1977）。名为密钥/口令的字段里的密钥仍是规则的（secretNames）。
 */
export function namesThing(v: string): boolean {
  const c = v.indexOf(":");
  if (c >= 0) {
    const n = v.slice(c + 1);
    if (n !== "" && allDigits(n)) v = v.slice(0, c);
  }
  if (uuidRe.test(v) || digestRe.test(v) || sriRe.test(v) || slugRe.test(v) || fileNameRe.test(v) || modelName(v)) return true;
  return (
    !/[ \t\n]/.test(v) &&
    (v.startsWith("/") || v.startsWith("~/") || v.startsWith("./") || v.startsWith("../") || (v.length > 3 && v[1] === ":" && v[2] === "\\"))
  );
}

const dashedRe = /^[a-z][a-z0-9.]*(?:-[a-z0-9.]+)+$/;
const sizePartRe = /^(?:\d+x)?\d+(?:\.\d+)?[bkm]$|^20\d{6}$/;
const dateIn = /(?:^|-)20\d\d-[01]\d-[0-3]\d(?:-|$)/;

/**
 * v 是模型或工具链的名字：小写词用连字符连起来，其中一个是尺寸（70b、8x7b、32k）或日期
 * （20241022、2026-09-01）。模型曾把 groqAPIModel = "llama3-70b-8192" 和 claudeAPIModel 的
 * claude-3-5-sonnet-20241022 当密钥（10-26）。密钥不这样写。
 */
export function modelName(v: string): boolean {
  if (!dashedRe.test(v)) return false;
  if (dateIn.test(v)) return true;
  return v.split("-").some((p) => sizePartRe.test(p));
}

// 模型、仓库或包的名字（qwen/qwen3-14b、acme/web）
const slugRe = /^[a-z0-9][a-z0-9._@-]*(?:\/[a-z0-9._@-]+)+$/;
// 小写文件名（make-icons.sh、run_all.py）
const fileNameRe = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.[a-z][a-z0-9]{0,4}$/;
const digestRe = /^(?:md5|sha-?(?:1|224|256|384|512)|blake2b?|blake3)[ :=-]+[0-9a-f]{32,128}$/i;
// 锁文件里包的摘要（Subresource Integrity：package-lock.json、pnpm-lock.yaml 的 "integrity"）：
// sha512- 加 base64 的哈希，模型还会把后面的 } 或引号带进来。Privacy Filter 曾把它们都当密钥。
const sriRe = /^sha(?:256|384|512)-[A-Za-z0-9+/]{43,86}={0,2}[}"',;)\]]*$/;

/**
 * v 是厂商和工具生成的 id 的形状：2 到 8 个小写字母的前缀、下划线、字母数字
 * （req_011CS…、toolu_01A…、call_x9…、msg_…），或更多的词与 nanoid 的 - 和 _
 * （req_gateway_7c41…、tb_Ra4Kp9-ZqT2_…）。Stripe 的密钥也是这个形状（sk_live_…、rk_test_…）：那不是 id。
 */
export function madeID(v: string): boolean {
  const u = v.indexOf("_");
  if (u < 0) return false;
  const p = v.slice(0, u);
  const rest = v.slice(u + 1);
  if (p.length < 2 || p.length > 8 || rest.length < 8) return false;
  if (!/^[a-z]+$/.test(p)) return false;
  let plain = true;
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if (c === 95 || c === 45) plain = false;
    else if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57))) return false;
  }
  return plain || !keyHeads.has(p);
}

/** 写成 id 样子的密钥的前缀（sk_live_…、whsec_…、shpat_…）。 */
const keyHeads: ReadonlySet<string> = new Set(["sk", "rk", "pk", "whsec", "shpat", "shpss", "xoxb", "xoxp"]);

// ---- 所在位置像不像（modelFits） ------------------------------------------------------------

const hexRe = /^[0-9a-f]{7,64}$/;
// EVM 链地址：0x 加 40 位十六进制，大小写不限（EIP-55 校验和是混合的）
const evmRe = /^0[xX][0-9a-fA-F]{40}$/;
const decimalRe = /^\d+\.\d+$/;
// 代码和笔记里写的十六进制数，至多 64 位：内存地址（0x004EA5E0）、常量、标志。模型把逆向笔记里的
// 地址当密钥，对话模型读到的是 {{SECRET_…}}（TakaNaShi_ShiKi on X）；当账号则成 {{ACCOUNT_…}}。
// modelTakes 认为它不是任何类别。没有哪个密钥这么短，也不像裸十六进制串那样要求线索（secretCued）：
// 地址处的函数常以密钥命名（DecryptKey: 0x004EA5E0）。十六进制写的密钥更长（0x 加 64 位）仍然遮。
const hexLiteral = /^0[xX][0-9a-fA-F]{1,16}$/;
// 用文字写的时刻，模型当成口令（release about 17:05Z）
const clockIn = /(?:^|[\t\n\f\r ])\d{1,2}:\d{2}(?::\d{2})?Z?(?:[\t\n\f\r ]|$)/;
const versionRe = /^v?\d+(?:\.\d+)+$/;
const sizeRe = /^\d+ ?[x×] ?\d+$/;
const uuidIn = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Go 模块缓存里的名字（d6426ecaaf0a28de@v31）
const modCacheRe = /^[0-9a-f]{16}@v\d+$/;
// 链接，或带路径的主机名（discord.gg/…）
const linkRe = /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/)/;
const identPath = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

const accountCues = ["account", "acct", "a/c", "iban", "routing", "sort code", "card", "账号", "帐号", "账户", "帐户", "卡号", "户名"];
const secretCues = ["key", "token", "secret", "password", "passwd", "密钥", "密码", "令牌"];
const phoneCues = ["phone", "tel", "mobile", "cell", "call", "whatsapp", "sms", "电话", "手机", "联系", "致电"];

/** 版本：清单或锁文件里钉的发行版本（^、~、>=、== 等范围符，数字用点连起来，预发布/构建标签）。 */
const versionRangeRe = /^(?:[~^]|[<>=!~]=?|==)?[vV]?\d+(?:\.\d+)+(?:[-+._]?(?:(?:alpha|beta|rc|pre|preview|post|dev|canary|next|nightly|snapshot|release|final|ga|stable|build|incubating)\d*|[abcmABCM]\d+|\d+))*$/i;

/** v 是发行版本，没有密钥是这样的：SECRET 规则曾在带 token/secret 的包名后面找到它，模型在清单里找到它。 */
export function versionValue(v: string): boolean {
  return versionRangeRe.test(v);
}

/**
 * 模型的值在 s[a:b] 按所在位置看是它的类别所说的东西，如同 modelTakes 按值本身看。
 * 在智能体发的 3 MB 请求里（10-25），模型遮了约 1,800 个值，规则遮了 17 个，大多遮错了：
 * 每轮 <total_tokens>14983666 tokens left</total_tokens> 里的计数当账号、一次运行的 id 当电话、
 * 系统提示里的 “Claude”“Opus 5.5” 当人、/Users/yetone 目录当人、toolu_01… 和 req_011C… 的尾巴当名字
 * 或密钥、grep 的模式当密钥。现在这些原样放行：
 *   - 从更长的词里切出来的一截，不管什么类别；
 *   - 带数字、斜杠、@ 或文件点的名字，全小写的（magpie、claude-in-chrome），路径的一部分，
 *     助手或模型自己的名字（Claude、Codex、Haiku 4.5）；
 *   - 账号是提交哈希、版本、或前面没有话说是账号的数字；电话是纯数字且没有话说是电话、不以 0 或 + 开头，
 *     或是 Unix 时间，不管前面是什么；
 *   - 密钥是模式的词 a|b|c、含 UUID（会话文件）、或是一段 JSON；
 *   - 账号或电话是尺寸（1624x1487）、绘图数据（SVG 路径 M16 0H44…）、diff 的 index 行；少于 7 位的电话、
 *     没有字母的地址。
 *
 * 一位报告者在 X 上发现模型“95%”的结果是错的（10-26）后，又在 22 个 Claude Code 会话上跑，
 * 它仍然多找了规则没找的 69 个值，约 55 个是错的，这些现在也放行：
 *   - 小数（指标 104.21875033916251）或 “run 48213097715” 当电话；
 *   - 当密钥的：紧跟在 id 的名字后面的值（with ID: kq3m8zx2t、<task-id>…、"backgroundTaskId":"…"）、
 *     模型或仓库的名字（qwen/qwen3-14b）、文件名（make-icons.sh）、grep 的正则（a\b\|b）、用文字写的时间
 *     （release about 17:05Z），以及线索比 “key:” 或 “token is” 更靠前的十六进制串
 *     （env -u GH_TOKEN gh run view 48213097715）；
 *   - 路径当地址、没有 @ 的主机名当邮箱；
 *   - 当人名的：缩写（CI）、驼峰的产品名（CodeRabbit）、文本里也作为主机名出现的词（Greptile、app.greptile.com）。
 *
 * 名字的每个词都以大写开头，只有名字里的小品词例外（van、de、bin）：“local LLM”、“User yetone” 和
 * claudeKeychain 是程序或日志的词。
 */
export function modelFits(s: string, a: number, b: number, kind: Kind, args: boolean, ctx: TextCtx = new TextCtx(s)): boolean {
  if ((a > 0 && wordAt(s, a - 1) && wordAt(s, a)) || (b < s.length && wordAt(s, b - 1) && wordAt(s, b))) return false;
  const v = s.slice(a, b);
  if (evmRe.test(v)) {
    // 钱包或合约地址（0x 加 40 位十六进制）是公开的，谁都能在链上读，对话模型需要它原样：遮了以后
    // 它把占位符当私钥，叫用户去轮换（0x0_air on X, 10-28）。密钥是 64 位十六进制；叫做密钥的仍然遮。
    return kind === "SECRET" && secretCued(s, a);
  }
  if (packageAt(s, a, b, ctx)) return false;
  switch (kind) {
    case "PERSON":
      return personFits(s, a, b, v, args, ctx);
    case "ACCOUNT":
      if ((hexRe.test(v) && /[abcdef]/.test(v)) || versionRe.test(v) || !numberLike(v)) return false;
      return !allDigits(v) || cued(s, a, accountCues);
    case "PHONE": {
      if (!numberLike(v) || countDigits(v) < 7 || epochNumber(v) || decimalRe.test(v) || isLetterCp(v.codePointAt(0)!)) return false;
      return !allDigits(v) || v[0] === "0" || cued(s, a, phoneCues);
    }
    case "ADDRESS":
      // 路径不是地址（-Users-x-projects-a/2b1a….jsonl）；中文地址没有空格，拉丁地址有
      if ((isASCII(v) && !/[ \t\n]/.test(v) && /[/\\]/.test(v)) || programWords(v)) return false;
      return hasLetter(v);
    case "SECRET": {
      // 被调用的名字不是值：gctx.GetInt64("user_id") 里的 gctx.GetInt64 曾被遮成编造的密钥（#4444）。
      // 只有紧挨着 '(' 的名字才是调用：散文里密钥后面可以跟一个括号（“the token is k3Xq9vB2mZ (rotated)”），
      // 模型也被问到散文，所以不取 notCode 对规则的值那样更宽的读法
      if (b < s.length && s[b] === "(" && identPath.test(v)) return false;
      if (
        !isWordCode(v.charCodeAt(0)) ||
        patternWords(v) ||
        regexpLike(v) ||
        idAfter(s, a) ||
        (v.includes(" ") && clockIn.test(v)) ||
        uuidIn.test(v) ||
        v.includes('": ') ||
        v.includes('", "') ||
        linkRe.test(v)
      ) {
        return false;
      }
      // 更长的 base64 串（图片、签名）的一截，是在 + 或 / 处切出来的
      if (
        (a > 1 && (s[a - 1] === "+" || s[a - 1] === "/") && wordAt(s, a - 2)) ||
        (b + 1 < s.length && (s[b] === "+" || s[b] === "/") && wordAt(s, b + 1))
      ) {
        return false;
      }
      // 裸十六进制串是哈希或 id，除非有话叫它密钥；后面跟着词的是工具输出里的哈希
      const f = fields(v);
      if ((f.length > 1 && hexRe.test(f[0]!)) || modCacheRe.test(v)) return false;
      if (pinnedAfter(s, b)) return false;
      if (allDigits(v)) return numberNamedSecret(s, a);
      if (wordsOnly(v) && !assignedSecret(s, a)) return false;
      return !hexRe.test(v) || secretCued(s, a);
    }
    case "EMAIL":
      // URL 里的 user:password@host 不是地址，同规则（#3538）
      return isWordCode(v.charCodeAt(0)) && !modCacheRe.test(v) && !inUserinfo(s, a);
  }
  return true;
}

/**
 * v 被模型当成人名或地名，其实是程序的词：有下划线（node_modules、__pycache__、node_modules 太，
 * 模型一路读进后面的句子），或是没有数字的小写拉丁字母（dist、vendor、site-packages、ls node_modules）。
 * 名字有自己的大写（personFits），地址有数字或大写（42 Wallaby Way），中文地址有汉字，都不是这样写的。
 * 模型曾把这样的文件夹当个人信息，智能体读到的是原来文件夹的位置上的占位符
 * （“node_modules给识别成姓名了”，kekek711 on X，10-29）。
 */
export function programWords(v: string): boolean {
  if (v.includes("_")) return true;
  return isASCII(v) && hasLetter(v) && !/[\p{Lu}\p{Nd}]/u.test(v);
}

/** v 全是小写词，只用 - . _ 连接：drizzle-orm、reflect-metadata、lodash.merge、secretstorage；以及路径或 Python 写的文件夹名：node_modules/、__pycache__。 */
const wordsOnlyRe = /^_*[a-z]+(?:[-._][a-z]+)*_*\/?$/;

/**
 * v 被模型当成密钥，但全由小写词组成，包名、工具名、设置名都这样。密钥是随机的：有数字、大写或符号，
 * SECRET 规则也要求密码赋值后的值有数字（secretValue）。AstrLink Guard 曾把 tsup 配置里 Markdown
 * 围栏中 external 列表里的 drizzle-orm 当密钥（dniray on Discord, v0.1.1976；那一行上单独就有 0.515 分），
 * 在 v0.1.1932 和 v0.1.1976 各放行了更多地方（import、package.json、tsc 报错）之后：包名出现的地方列不完，
 * 所以由形状决定。这样的值只有被赋给密钥的名字时才是密钥（assignedSecret）：
 * PASSWORD=opensesame、"password": "letmeinplease"、the wifi password is purplemonkey。
 */
export function wordsOnly(v: string): boolean {
  return wordsOnlyRe.test(v);
}

/**
 * s[a] 处的值被赋给密钥的名字：名字，然后是 =、:、is 或 是（和它们周围的引号），紧挨着值。
 * 列表的逗号不是赋值，不管再往前是什么：'jsonwebtoken', 'drizzle-orm'（secretCued 把 token 算进去了）。
 * 值之前只读 64 个码元（magpie 是 64 字节）。
 */
export function assignedSecret(s: string, a: number): boolean {
  const before = trimRightSet(s.slice(Math.max(0, a - 64), a), " \t\"'`“「").toLowerCase();
  for (const sep of ["=", ":", "：", " is", " was", "是", "为", "為"]) {
    if (!before.endsWith(sep)) continue;
    const name = trimRightSet(before.slice(0, before.length - sep.length), " \t\"'`:");
    let i = name.length;
    while (i > 0 && (isWordCode(name.charCodeAt(i - 1)) || name[i - 1] === "." || name[i - 1] === "-")) i--;
    if (i === name.length) {
      // 中文名：密码是、令牌为
      return secretCues.some((c) => c.charCodeAt(0) >= 0x80 && name.endsWith(c));
    }
    const tail = name.slice(i);
    return (
      secretCues.some((c) => c.charCodeAt(0) < 0x80 && tail.includes(c)) || tail.includes("pass") || tail.includes("pwd") || tail.includes("credential")
    );
  }
  return false;
}

/**
 * 在 s[b] 之前结束的值是包名，要求像 pip 那样在它后面钉了版本：django-rest-passwordreset==1.4.0、
 * tokenizers>=0.15、a-lib~=2.1。AstrLink Guard 曾把名字里带 password 的包当密钥，智能体在
 * requirements.txt 里读到 {{SECRET_…}}==1.4.0（dniray on Discord, v0.1.1917）。密钥后面不会钉版本；
 * @ 之前的密码和地址（s3cret@10.0.0.5）不是钉版本。
 */
export function pinnedAfter(s: string, b: number): boolean {
  for (const op of ["===", "==", ">=", "<=", "~=", "!="]) {
    if (s.startsWith(op, b)) {
      let i = b + op.length;
      while (s[i] === " ") i++;
      return i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57;
    }
  }
  return false;
}

/**
 * v 是人名以外的东西：两个词以上要求每个词大写开头（小品词 van、de、bin 例外）；
 * 不含数字、/、\、@、<、>、|、=、_；小写的拉丁串不是名字；文件名、路径的一部分、冒号、缩写、
 * 驼峰产品名、也作为主机名出现的词、应用名都不是；助手的名字不是。
 */
function personFits(s: string, a: number, b: number, v: string, args: boolean, ctx: TextCtx): boolean {
  if (/[0-9/\\@<>|=_]/.test(v) || (!hasUpper(v) && isASCII(v))) return false;
  // 文件名：LESSONS.md，点后面紧跟字母
  if (/\.[A-Za-z]/.test(v)) return false;
  // 路径的一部分：/Users/yetone、~/.orca/
  if (
    (a > 0 && (s[a - 1] === "/" || s[a - 1] === "\\" || (s[a - 1] === "." && a > 1 && (s[a - 2] === "/" || s[a - 2] === "\\")))) ||
    (b < s.length && (s[b] === "/" || s[b] === "\\"))
  ) {
    return false;
  }
  if (v.includes(":")) return false;
  // 缩写（CI、API）、驼峰的产品名（CodeRabbit、OpenAI）、站点名（Greptile 在 app.greptile.com 旁边）都不是谁的名字
  const w = fields(v);
  if (w.length === 1 && (/^[A-Z]*$/.test(v) || camelProduct(v) || hostIn(ctx, v))) return false;
  // 模型当成名的应用或产品名，在它的句子说的是物的时候（thingname.ts）；工具调用参数里绝不走这条，
  // 参数里点名的是工具替谁做事（{"recipient":"Rina"}）
  if (w.length === 1 && isASCII(v) && !args && thingNamed(s, a, b, ctx)) return false;
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!.charCodeAt(0);
    if (c >= 97 && c <= 122 && (i === 0 || !nameParticles.has(w[i]!))) return false;
    if (assistantNames.has(w[i]!.toLowerCase())) return false;
  }
  return true;
}

/** v 在三个小写字母之后有大写，产品是这样写的（CodeRabbit、OpenAI），名字不是（McDonald、DeAndre、MacKenzie）。 */
function camelProduct(v: string): boolean {
  let lower = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 97 && c <= 122) lower++;
    else if (c >= 65 && c <= 90) {
      if (lower >= 3) return true;
      lower = 0;
    } else lower = 0;
  }
  return false;
}

/** 域名的其余部分：.com、.greptile.com，在主机结束的地方结束（不是 @ 或更长的词）。 */
const hostTail = /(?:\.[a-z0-9-]+)*\.[a-z]{2,6}(?:[/:\t\n\f\r "'),`]|$)/y;

/** s 里有词 w（不分大小写）作为主机名：域名的第一段或点之后的一段（greptile.com、app.greptile.com），地址的不算（matt.lee@…）。 */
function hostIn(ctx: TextCtx, w: string): boolean {
  const ls = ctx.lower;
  const lw = w.toLowerCase();
  for (let i = 0; ; ) {
    const k = ls.indexOf(lw + ".", i);
    if (k < 0) return false;
    i = k + 1;
    if (k > 0 && !"/.@ \t\n\"'(`".includes(ls[k - 1]!)) continue;
    hostTail.lastIndex = k + lw.length;
    if (hostTail.test(ls)) return true;
  }
}

/** 名字里可以出现在其他词之间的小写词：Ludwig van Beethoven、Ibn al Haytham。 */
const nameParticles: ReadonlySet<string> = new Set([
  "van", "von", "der", "den", "de", "da", "del", "della", "di", "du", "la", "le", "bin", "binti", "al", "el", "y", "dos", "das", "do", "ter", "ten", "zu",
]);

/**
 * v 写得像数字：数字，和把它们分组的空格、连字符、点、括号、+，至多带一两个字母（IBAN、ext.）。
 * 尺寸不是号码（1624x1487）。长度按 UTF-8 字节数比，同 magpie。
 */
function numberLike(v: string): boolean {
  if (sizeRe.test(v) || v.includes("..")) return false;
  let letters = 0;
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 48 && cp <= 57) || " -.()+/".includes(ch)) continue;
    if (isLetterCp(cp)) letters++;
    else return false;
  }
  return letters <= 4 && countDigits(v) * 2 > byteLen(v);
}

/**
 * v 是 Unix 时间，日志或工具的 JSON 里这样写：十位，或毫秒的十三位，只有数字，以 1 开头。
 * 模型曾把 "timestamp": 1792903687 当电话，前面的 "tool_call" 当线索（#3577）。没有电话这样写：
 * 北美号码的区号以 2 到 9 开头，中国手机十一位（PHONE 规则的）。
 */
export function epochNumber(v: string): boolean {
  if ((v.length !== 10 && v.length !== 13) || v[0] !== "1") return false;
  return allDigits(v);
}

/** 智能体和模型对自己的称呼，每份系统提示里都有：模型把每一个当人名。 */
export const assistantNames: ReadonlySet<string> = new Set([
  "claude", "chatgpt", "gpt", "codex", "gemini", "copilot", "grok", "kimi", "qwen", "deepseek", "cursor", "devin",
  "kiro", "opencode", "opus", "sonnet", "haiku", "fable", "glm", "doubao", "magpie", "jev",
]);

/** 值前 40 个码元（magpie 是 40 字节）里，小写后含 cues 之一。 */
function cued(s: string, at: number, cues: readonly string[]): boolean {
  const before = s.slice(Math.max(0, at - 40), at).toLowerCase();
  return cues.some((c) => before.includes(c));
}

/** v 是正则：grep 的 \| 分支，或 \b 词边界（qwen3-max\b\|qwen/qwen3）。 */
function regexpLike(v: string): boolean {
  return v.includes("\\|") || v.includes("\\b");
}

/**
 * s[a:] 处的值紧跟在 id 一词之后，工具输出这样给任务或作业命名（with ID: kq3m8zx2t、(ID: bv7n2wq5p)、
 * <task-id>…、"backgroundTaskId":"…"、"org_id": "…"）：id 不是密钥。回看 24 个码元（magpie 是 24 字节）。
 */
export function idAfter(s: string, a: number): boolean {
  const t = trimRightSet(s.slice(Math.max(0, a - 24), a), " :=#(>\"'`");
  const n = t.length;
  if (n < 2 || !/^id$/i.test(t.slice(n - 2))) return false;
  return n === 2 || !isLetterCp(t.codePointAt(n - 3)!) || (t[n - 2] === "I" && t[n - 1] === "d");
}

/**
 * s[at:] 处的十六进制串被叫做密钥、令牌或口令：secretCues 之一紧挨着它，带着那个线索自己的词，
 * 中间只隔 is、冒号或 =（api key: 9f2c…、token is 9f2c…）。更远的线索说的是别的：
 * “env -u GH_TOKEN gh run view 48213097715” 里的 GH_TOKEN 不是那个 run 的。
 */
export function secretCued(s: string, at: number): boolean {
  const before = s.slice(Math.max(0, at - 40), at).toLowerCase();
  for (const c of secretCues) {
    const k = before.lastIndexOf(c);
    if (k < 0) continue;
    const gap = before.slice(k + c.length).replace(/^[_\p{L}\p{Nd}]+/u, "");
    const words = gap.split(/[^\p{L}\p{Nd}]+/u).filter((w) => w !== "");
    if (words.length === 0 || (words.length === 1 && (words[0] === "is" || words[0] === "was" || words[0] === "是" || words[0] === "为"))) return true;
  }
  return false;
}

/**
 * s[a:] 处的十进制数字串，模型当成密钥，被赋予了密钥的名字：名字紧挨着它，然后是 =、:、is 或标签的 >
 * （和引号），名字以密钥、令牌、口令或 PIN 之类的词结尾（api_key=、"token": 、PIN:、密码是）。别处数字
 * 是计数、时间或 id。secretCued（十六进制串用的）取名字中任何位置的线索，把 Claude Code 的
 * <total_tokens>14998720 tokens left</total_tokens> 读成了令牌：每一轮的计数都变成 {{SECRET_…}}
 * （steven_4422 on Discord, 10-31）。越过那个词继续的名字说的是它数的东西（total_tokens、max_tokens、
 * token_count、keys）。值前 40 个码元（magpie 是 40 字节）。
 */
export function numberNamedSecret(s: string, a: number): boolean {
  let before = s.slice(Math.max(0, a - 40), a).toLowerCase();
  for (;;) {
    let t = trimRightSet(before, " \t\"'`=:：>“「");
    for (const sep of [" is", " was", "是", "为", "為"]) {
      if (t.endsWith(sep)) t = t.slice(0, t.length - sep.length);
    }
    if (t === before) break;
    before = t;
  }
  if (before === "") return false;
  for (const c of numberSecretNames) {
    // PIN 这个词自己站着（pin、user_pin），不是别的词的结尾（spin、mapping）
    if (before.endsWith(c) && (c !== "pin" || before.length === 3 || !isLetterCp(before.codePointAt(before.length - 4)!))) return true;
  }
  return false;
}

/** 让数字有了密钥的位置的名字，以这些结尾。 */
const numberSecretNames = ["key", "token", "secret", "password", "passwd", "pass", "pwd", "passcode", "pin", "密钥", "密码", "令牌", "口令"];

/** v 是三个以上用 | 连起来的词，grep 或正则的分支那样。 */
export function patternWords(v: string): boolean {
  const parts = v.split("|");
  if (parts.length < 3) return false;
  return parts.every((p) => p !== "" && hasLetter(p) && /^[A-Za-z0-9_.-]*$/.test(p));
}

/**
 * s[a] 在 URL 的 authority 里，在 scheme:// 之后、主机之前：从那里往回到 // 之间没有 /、?、#、空白、
 * 引号、<、> 或 @。
 */
function inUserinfo(s: string, a: number): boolean {
  let i = a;
  while (i > 0 && !" \t\r\n/?#\"'<>@`".includes(s[i - 1]!)) i--;
  if (i < 3 || s[i - 1] !== "/" || s[i - 2] !== "/" || s[i - 3] !== ":") return false;
  const j = i - 3; // scheme 在 s[j] 结束，即它的冒号
  let k = j;
  while (k > 0 && /[A-Za-z0-9+.-]/.test(s[k - 1]!)) k--;
  while (k < j && !/[A-Za-z]/.test(s[k]!)) k++; // scheme 以字母开头
  return k < j;
}
