// 移植自 magpie internal/redact/redact.go 的 realEmail 及其辅助（mailHost、mailTLD、fileHost、
// fileStem 与各张名单）。模型报的 EMAIL 要先过它：文件名、符号、示例域名都不是邮箱。

import { ICANN_TLDS } from "./tlds.ts";

/** 链接器表名（system@plt、puts@got.plt、foo@plt.sec），不是域名标签。 */
const linkerWords = new Set(["plt", "got", "sec", "iplt", "igot"]);

/** 智能体按名字读取的文件，落在域名位置（.md）的 “@AGENTS.md” 不是邮箱。 */
const docFiles = new Set([
  "agents.md", "claude.md", "gemini.md", "readme.md", "skill.md",
  "changelog.md", "contributing.md", "license.md", "lessons.md", "todo.md",
  "copilot-instructions.md", "crush.md", "qwen.md", "iflow.md", "warp.md",
]);

/** 机构内部邮件可能用、注册表里没有的后缀：这样的地址照样是某人的。 */
const localTLDs = new Set(["local", "internal", "lan", "corp", "home", "intranet", "localdomain"]);

/**
 * 邮件能发往的顶级域：公共后缀表的 ICANN 部分，或机构自己的。装饰器/模块属性后面的词
 * （x@pytest.fixture）不是任何注册表里的域。
 */
function mailTLD(tld: string): boolean {
  return localTLDs.has(tld) || ICANN_TLDS.has(tld);
}

/**
 * 不是顶级域的文件扩展名，所以以它结尾的是文件名而不是地址：Mac 存的二倍图
 * 261020_14-16-11@2x.jpg 曾被遮成 {{EMAIL_…}}，Pi 就读不了这个文件（#3029）。
 * 其它文件同理（intro@2x.mp4、strings@base.json）。
 */
const fileExt = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "heif",
  "avif", "bmp", "tif", "tiff", "ico", "icns", "pdf",
  "svgz", "apng", "jxl", "psd", "eps", "lottie",
  "mp4", "m4v", "webm", "mkv", "avi", "mp3", "m4a", "wav",
  "ogg", "flac", "aac", "ttf", "otf", "woff", "woff2", "eot",
  "json", "yaml", "yml", "toml", "xml", "txt", "csv", "tsv",
  "log", "html", "htm", "css", "scss", "less", "js", "mjs",
  "cjs", "jsx", "ts", "tsx", "doc", "docx", "xls", "xlsx",
  "ppt", "pptx", "gz", "tgz", "tar", "rar", "7z", "dmg",
]);

/** 同时也是顶级域的文件扩展名（.zip .mov .md .map）：只有前面带倍率才是文件名，ops@files.zip 是地址。 */
const scaleExt = new Set(["zip", "mov", "md", "map"]);

const scaleRe = /^[0-9]+(?:\.[0-9]+)?x$/;

function fileHost(host: string): boolean {
  const dot = host.lastIndexOf(".");
  const ext = host.slice(dot + 1);
  return fileExt.has(ext) || (dot > 0 && scaleExt.has(ext) && scaleRe.test(host.slice(0, dot)));
}

/** 去掉 host 末尾的文件扩展名（acme.com.tar.gz → acme.com）。 */
function fileStem(host: string): string {
  for (;;) {
    const dot = host.lastIndexOf(".");
    if (dot < 0 || !fileExt.has(host.slice(dot + 1))) return host;
    host = host.slice(0, dot);
  }
}

/**
 * host（@ 之后的部分）能否是邮件域：有点、各标签是字母数字连字符（或它本国文字，例子.中国），
 * 且不是链接器的表；local 里不能再有 @。反汇编里的符号（system@plt、memcpy@GLIBC_2.14、
 * foo@@GLIBC_2.2.5）曾被当邮箱，.got 恰好是顶级域，逆向工程的用户只好关掉遮挡。
 */
function mailHost(local: string, host: string): boolean {
  if (local.endsWith("@") || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) return false;
  let linker = true;
  for (const l of host.split(".")) {
    // 只拒绝 ASCII 里不是 小写字母/数字/连字符 的字符（host 已小写）
    if (l === "" || /[^a-z0-9\-\u0080-\uffff]/.test(l)) return false;
    if (!linkerWords.has(l)) linker = false;
  }
  return !linker;
}

/** v 含 @。判断它是不是真正的邮箱地址。 */
export function realEmail(v: string): boolean {
  const at = v.lastIndexOf("@");
  const local = v.slice(0, at);
  if (local.toLowerCase() === "git") return false; // git@github.com：SSH 远端
  let host = v.slice(at + 1).toLowerCase();
  if (!mailHost(local, host)) return false;
  if (fileHost(host)) {
    // 文件名末尾：扩展名前面的地址（alice.smith@acme.com.pdf）照样是某人的；
    // 倍率或普通词（@2x.jpg、@final.pdf）不是域名
    host = fileStem(host);
    if (!host.includes(".") || fileHost(host) || !mailHost(local, host)) return false;
  }
  if (docFiles.has(host) || !mailTLD(host.slice(host.lastIndexOf(".") + 1))) return false;
  for (const fake of ["example.com", "example.org", "example.net", "localhost", ".test", ".invalid", ".example"]) {
    // 保留域名：完全相等或以 "." 为标签边界的子域（customerexample.com 不是 example.com）；.test 这类是顶级后缀
    const bare = fake.replace(/^\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return false;
  }
  return !host.startsWith("noreply") && !v.includes("noreply@");
}
