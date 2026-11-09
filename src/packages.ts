// 移植自 magpie internal/redact/model.go 的 packageAt 及其子判断：一个值若按位置看是包名/模块名
// （import 的模块、清单里的依赖、node_modules 下的目录、“Cannot find module”、install 命令、
// name@版本），就不是密钥。模型报的 SECRET 和“已知值”补遮（known.ts）都先问它。

import { isSpace, isWordCode, trimLeftSet, trimRightSet, fields, TextCtx, wordEnd } from "./text.ts";

/** 代码里引用模块的写法：drizzle-orm、@scope/name/sub、node:fs、./db/schema、golang.org/x/net、serde_json::Value。 */
export const moduleRe = /^(?:[a-z]+:)?@?[A-Za-z0-9_.~-]+(?:(?:\/|::)[A-Za-z0-9_.~@-]+)*$/;

const moduleByte = (c: string | undefined): boolean => c !== undefined && (isWordCode(c.charCodeAt(0)) || c === "." || c === "-" || c === "~" || c === "@");

/**
 * 依赖版本相关的前瞻窗口（码元）。magpie 在 Go 里切子串是 O(1)，这里同样不复制，
 * 但向后找下一个引号等“找到为止”的扫描设一个上限，避免一行很长的文本里每个已知值都扫到行尾。
 * 合法的版本号/范围远短于此。
 */
const LOOKAHEAD = 1200;

/** installedAt 向行首回看的最大长度（码元）。命令词与包名之间不会隔这么远。 */
const INSTALL_WINDOW = 4096;

/**
 * 去掉编辑器/工具放在代码前面的东西：行号（Claude Code 的 Read 给 "     1→import drizzle from 'drizzle-orm'"，
 * cat -n 是制表符，grep -n 是冒号）和 diff 的 +/-。有了行号，默认导入就不再被认成 import 行（dniray, v0.1.1965）。
 */
export function codeHead(head: string): string {
  let h = trimLeftSet(head, " \t");
  let i = 0;
  while (i < h.length && h.charCodeAt(i) >= 48 && h.charCodeAt(i) <= 57) i++;
  if (i > 0) {
    for (const sep of ["→", "\t", ":", "|"]) {
      if (h.startsWith(sep, i)) {
        h = trimLeftSet(h.slice(i + sep.length), " \t");
        break;
      }
    }
  }
  if (h !== "" && (h[0] === "+" || h[0] === "-")) h = trimLeftSet(h.slice(1), " \t");
  return h;
}

/**
 * s[a:b] 是代码加载的那个模块：import { eq } from 'drizzle-orm'、require(' jsonwebtoken ')、
 * import('x')、from django.contrib import auth、use jsonwebtoken::encode。
 * 密钥从来不是代码加载的模块。散文不是代码：“the token from 'a1b2…'” 照旧判断，
 * from 只在 import/export 行或 } * 之后才算。
 */
function moduleAt(s: string, a: number, b: number, ctx: TextCtx): boolean {
  if (!moduleRe.test(s.slice(a, b))) return false;
  const line = ctx.lineStart(a);
  const head = codeHead(s.slice(line, a));
  const tail = trimLeftSet(s.slice(b, ctx.lineEnd(b)), " \t");
  let q = trimRightSet(head, " \t");
  if (q !== "" && "'\"`".includes(q[q.length - 1]!)) {
    // 有引号，且在同一种引号里结束：from ' drizzle-orm '
    if (tail === "" || tail[0] !== q[q.length - 1]) return false;
    q = trimRightSet(q.slice(0, -1), " \t");
    if (q.endsWith("(")) {
      q = trimRightSet(q.slice(0, -1), " \t");
      return wordEnd(q, "require") || wordEnd(q, "import");
    }
    if (!wordEnd(q, "from")) {
      // import 'reflect-metadata'
      return q === "import";
    }
    q = trimRightSet(q.slice(0, -"from".length), " \t");
    return q.startsWith("import") || q.startsWith("export") || q.endsWith("}") || q.endsWith("*") || q === "";
  }
  // 没有引号：Python 和 Rust 的写法，词在行首
  switch (trimRightSet(head, " \t")) {
    case "from":
      return tail.startsWith("import ");
    case "import":
      return tail === "" || tail[0] === "," || tail[0] === ";" || tail.startsWith("as ");
    case "use":
    case "extern crate":
      return tail.startsWith("::") || tail === "" || tail[0] === ";" || tail[0] === "{";
  }
  return false;
}

const depRangeRe = /^(?:[~^]|[<>]=?|=)?[vV]?\d+(?:\.(?:\d+|[xX*]))*(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * v 是清单里依赖钉的东西：版本或范围（^0.36.4、>=0.30.0 <1、9、1.x、*）、workspace/catalog、
 * 标签（latest、next）、或来源（npm:、file:、link:、git+…、github:）。
 */
function depVersion(v: string): boolean {
  for (const p of ["workspace:", "catalog:", "npm:", "file:", "link:", "portal:", "git+", "git:", "github:", "http://", "https://"]) {
    if (v.startsWith(p)) return true;
  }
  switch (v) {
    case "*":
    case "latest":
    case "next":
    case "beta":
    case "canary":
    case "x":
      return true;
  }
  for (const part of fields(v.replace(/\|\||[ ]-[ ]/g, " "))) {
    if (!depRangeRe.test(part)) return false;
  }
  return v !== "";
}

/**
 * s[a:b] 是清单里的依赖名：值是版本或范围的 JSON 键（"drizzle-orm": "^0.36.4"、"x": "workspace:*"），
 * 或行首的 TOML（jsonwebtoken = "9.2.0"）。值不是版本的键（{"Zq8v…": "hunter2"}）照旧判断。
 */
function dependencyAt(s: string, a: number, b: number): boolean {
  let rest: string;
  if (a > 0 && s[a - 1] === '"' && b < s.length && s[b] === '"') {
    rest = trimLeftSet(s.slice(b + 1, b + 1 + LOOKAHEAD), " \t");
    if (!rest.startsWith(":")) return false;
    rest = trimLeftSet(rest.slice(1), " \t");
  } else {
    // 行首到 a 只能是空白
    let i = a;
    while (i > 0 && (s[i - 1] === " " || s[i - 1] === "\t")) i--;
    if (i > 0 && s[i - 1] !== "\n") return false;
    rest = trimLeftSet(s.slice(b, b + LOOKAHEAD), " \t");
    if (!rest.startsWith("=") || rest.startsWith("==")) return false;
    rest = trimLeftSet(rest.slice(1), " \t");
    if (rest.startsWith("{")) {
      // jsonwebtoken = { version = "9", features = […] }
      return trimLeftSet(rest.slice(1), " \t").startsWith("version");
    }
  }
  if (!rest.startsWith('"')) return false;
  const end = rest.indexOf('"', 1);
  if (end < 0) return false;
  return depVersion(rest.slice(1, end));
}

/** a 处的名字是包安装目录：node_modules/drizzle-orm/…、site-packages/secretstorage/…。 */
function underPackages(s: string, a: number): boolean {
  const pre = s.slice(Math.max(0, a - 14), a);
  return pre.endsWith("node_modules/") || pre.endsWith("node_modules\\") || pre.endsWith("site-packages/") || pre.endsWith("site-packages\\");
}

/**
 * s[a:b] 被引号包着，前面是报错里“找不到模块”的措辞：tsc/Node 的 Cannot find module 'x'、
 * Python 的 No module named 'x'、打包器的 Can't resolve 'x'。
 *
 * 措辞紧挨着引号，读它之前的内容只读最后 64 个码元（magpie 是 64 字节，与 assignedSecret 读值前
 * 64 个一样；这里按 UTF-16 码元计）。以前把引号之前的全部文本读一遍再小写，会话里每个已遮值
 * 出现一次就重复付一次整段长度，555 KB 的一轮卡在遮挡里几分钟、回 504（#4766）。引号前的空格
 * 先去掉再取窗口，所以中间空格再多也读得到措辞。逐字小写与上下文无关，对窗口小写与对全文
 * 小写取最后几个字符结果一样。
 */
export function missingModuleAt(s: string, a: number, b: number): boolean {
  if (a === 0 || b >= s.length || !"'\"`".includes(s[a - 1]!) || s[b] !== s[a - 1]) return false;
  let e = a - 1;
  while (e > 0 && (s[e - 1] === " " || s[e - 1] === "\t")) e--;
  const q = s.slice(Math.max(0, e - 64), e).toLowerCase();
  for (const w of ["find module", "find package", "module named", "resolve", "resolve import", "resolve module"]) {
    if (wordEnd(q, w)) return true;
  }
  return false;
}

/** 包管理器里后面接包名的命令。 */
const installRe = /(?:^|[\t\n\f\r ;&|(`$])(?:npm|pnpm|yarn|bun|npx|pip|pip3|uv|poetry|pipx|cargo|gem|composer|deno|go)(?: +(?:pip|-[\w-]+))* +(?:add|install|i|remove|rm|uninstall|un|get|require|update|upgrade|up)(?: |$)/g;

/** 命令的参数是凭据的标志（--token、--auth-key）。 */
function credFlag(f: string): boolean {
  f = f.toLowerCase();
  for (const w of ["token", "key", "pass", "secret", "auth", "cred"]) if (f.includes(w)) return true;
  return false;
}

/**
 * s[a:b] 是同一行命令安装或卸载的包：pnpm add drizzle-orm postgres、npm i -D x、pip install a-lib。
 * 凭据标志后面的值（--token、--auth）是那个标志的，照旧判断。
 *
 * 向行首回看最多 INSTALL_WINDOW 个码元（magpie 无上限，在一行很长的文本里每个已知值都会重跑
 * 整行正则）；窗口从行中间切开时对齐到下一个空白之后，免得窗口起点被 `^` 误认成行首。
 */
function installedAt(s: string, a: number, b: number, ctx: TextCtx): boolean {
  if (b < s.length && !isSpace(s[b]) && s[b] !== ";" && s[b] !== "&" && s[b] !== "|" && s[b] !== ")") return false;
  const line = ctx.lineStart(a);
  let from = line;
  if (a - line > INSTALL_WINDOW) {
    from = a - INSTALL_WINDOW;
    while (from < a && !/[\t\n\f\r ]/.test(s[from - 1]!)) from++;
  }
  const seg = s.slice(from, a);
  let last = -1;
  installRe.lastIndex = 0;
  for (let m = installRe.exec(seg); m; m = installRe.exec(seg)) last = m.index + m[0].length;
  if (last < 0) return false;
  const args = fields(seg.slice(last));
  if (a > 0 && !isSpace(s[a - 1])) return false;
  for (const w of args) if (/[;&|<>`$]/.test(w)) return false;
  const n = args.length;
  if (n > 0 && args[n - 1]!.startsWith("-") && credFlag(args[n - 1]!)) return false;
  return true;
}

const pinVersionRe = /[\^~]?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?/y;

/**
 * s[a:b] 是用 @ 钉了版本的包名，npm/pnpm 那样写：drizzle-orm@0.36.4、js-tokens@4.0.0:。
 * 包名是小写的，版本是三个数字且不是 IPv4，所以 s3cretPass@10.0.0.5 仍是密码。
 */
function pinnedAt(s: string, a: number, b: number): boolean {
  if (b >= s.length || s[b] !== "@") return false;
  const v = s.slice(a, b);
  if (v.toLowerCase() !== v) return false;
  pinVersionRe.lastIndex = b + 1;
  const m = pinVersionRe.exec(s);
  return m !== null && !(s.length > b + 1 + m[0].length && s[b + 1 + m[0].length] === ".");
}

/**
 * s[a:b] 按位置是包名或模块名：代码加载的模块（moduleAt）、清单钉的依赖（dependencyAt）、
 * node_modules/site-packages 下的目录、报错找不到的模块（missingModuleAt）、install 命令点名的包
 * （installedAt）、或 @ 钉了版本的包（pinnedAt）。
 * 本地模型曾把 drizzle-orm 当密钥；遮过一次它就成“已知值”，在 import 行也被遮，所以 known.ts 同样要问它。
 */
export function packageAt(s: string, a: number, b: number, ctx: TextCtx = new TextCtx(s)): boolean {
  // 找到的只是名字的一截时取全名：drizzle-orm/pg-core 里的 drizzle-orm、@scope/name 里的 name
  while (b + 1 < s.length && s[b] === "/" && moduleByte(s[b + 1])) {
    b++;
    while (b < s.length && moduleByte(s[b])) b++;
  }
  if (a > 2 && s[a - 1] === "/") {
    let i = a - 1;
    while (i > 0 && moduleByte(s[i - 1])) i--;
    if (i < a - 2 && s[i] === "@") a = i;
  }
  if (!moduleRe.test(s.slice(a, b))) return false;
  return (
    moduleAt(s, a, b, ctx) ||
    dependencyAt(s, a, b) ||
    underPackages(s, a) ||
    missingModuleAt(s, a, b) ||
    installedAt(s, a, b, ctx) ||
    pinnedAt(s, a, b)
  );
}
