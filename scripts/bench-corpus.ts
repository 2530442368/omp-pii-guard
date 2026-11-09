// 基准用的合成语料生成器：固定种子，同一种子永远产出同一份语料。
// 里面所有“个人信息”都是随机拼出来的虚构值，不对应任何真实的人；密码是随机字符串，不是任何真实密钥格式。
// 电话/卡号/域名是随机生成的，与真实存在的号码或域名纯属巧合的概率不为零，但从未被拨打、转账、投递或访问。
//   - 邮箱域名特意不用 example.com/.org/.net、.test、.invalid、.example、localhost、noreply：
//     这些会被误报过滤规则当成假地址放行（src/email.ts realEmail），召回率就不是在测“会被当成真地址的邮箱”。
//   - 手机号随机的是中国大陆 11 位手机号形态；境外电话用 555-01xx（北美为虚构作品保留的号段）。
//   - 银行账号以 9 开头（不对应常见发卡行号段）；信用卡号用 Stripe 公开测试号段 4000 00 开头、Luhn 校验通过。
//   - 密码：10–16 位，含大小写字母、数字、符号，不以任何已知密钥前缀（sk-、ghp_、AKIA、xox 等）开头。

import type { Kind } from "../src/types.ts";

export type Lang = "zh" | "en";

/** 确定性伪随机（xorshift32）。 */
export function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

export type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const chars = (r: Rand, alphabet: string, n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
};

// ---- 虚构值 -----------------------------------------------------------------------------------

const ZH_SURNAME = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董潘袁蔡蒋余于杜叶程魏苏吕丁任卢姚沈钟姜崔谭陆范汪廖石金韦贾夏傅方邹熊孟秦邱侯江尹薛段雷黎史陶贺顾毛郝龚邵万钱武戴孔汤";
const ZH_GIVEN = "伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞刚英华慧巧美鹏辉玲玉萍红琴云莉晨宇浩然轩欣怡涵佳睿思远博文雅婷凯悦瑞帆楠琳";
const EN_FIRST = ["Alden", "Briar", "Calla", "Dorian", "Elowen", "Fenn", "Garrick", "Hollis", "Isolde", "Jasper", "Keira", "Lorne", "Maren", "Nolan", "Odette", "Perrin", "Quinn", "Rowan", "Sabine", "Tobias", "Ursula", "Vance", "Wren", "Xavier", "Yara", "Zane"];
const EN_LAST = ["Ashdown", "Brannock", "Carraway", "Dunmore", "Ellery", "Fairbanks", "Gallagher", "Hartwell", "Ironside", "Jessop", "Kingsley", "Lockridge", "Marlowe", "Netherby", "Oakhurst", "Pemberton", "Quillfeather", "Rutherford", "Stanhope", "Thornbury", "Underhill", "Vandermeer", "Whitlock", "Yarrow"];

const ZH_PLACE = ["北京市朝阳区", "上海市浦东新区", "广东省深圳市南山区", "浙江省杭州市西湖区", "四川省成都市武侯区", "湖北省武汉市洪山区", "江苏省南京市鼓楼区", "陕西省西安市雁塔区", "重庆市渝北区", "福建省厦门市思明区", "山东省青岛市市南区", "湖南省长沙市岳麓区"];
const ZH_ROAD = ["建设路", "人民路", "科技园路", "解放大道", "中山路", "文昌路", "云栖路", "桂花街", "望江路", "滨河大道", "学院路", "新华街", "创业大道", "梧桐路"];
const EN_ROAD = ["Maple Grove Drive", "Cedar Hollow Lane", "Birchwood Avenue", "Lakeview Terrace", "Willow Creek Road", "Harbor Point Street", "Orchard Hill Way", "Juniper Court", "Summit Ridge Boulevard", "Stonebridge Road"];
const EN_CITY: readonly [string, string, string][] = [
  ["Springfield", "IL", "62704"], ["Riverton", "WY", "82501"], ["Fairview", "OR", "97024"], ["Lakewood", "CO", "80226"],
  ["Georgetown", "TX", "78626"], ["Clinton", "MA", "01510"], ["Salem", "NH", "03079"], ["Madison", "WI", "53703"],
];
const DOMAIN_STEM = ["lumenbridge", "tidalforge", "quietharbor", "brightfield-labs", "ironleaf", "northgate-systems", "paperkite", "stonecircle", "qiyuan-tech", "yunxi-works", "hengda-demo", "ruifeng-soft"];
const DOMAIN_TLD = ["com", "io", "net", "cn", "co", "dev", "app"];
const MAIL_WORD = ["zhou", "lin", "chen", "wang", "liu", "xu", "han", "mei", "alden", "briar", "calla", "dorian", "elowen", "fenn", "garrick", "hollis", "quinn", "rowan", "sabine", "wren"];

export interface Planted {
  start: number;
  end: number;
  kind: Kind;
  lang: Lang;
  /** 值所在的上下文样式：sentence（自然语句）/ field（键: 值）/ json / env。 */
  style: string;
  /** 值本身（虚构）。 */
  value: string;
}

export interface Doc {
  text: string;
  planted: Planted[];
}

type Maker = (r: Rand) => string;

const makers: Record<Lang, Record<Kind, Maker>> = {
  zh: {
    PERSON: (r) => pick(r, [...ZH_SURNAME]) + chars(r, ZH_GIVEN, r() < 0.8 ? 2 : 1),
    PHONE: (r) => `1${pick(r, [3, 5, 7, 8, 9])}${chars(r, "0123456789", 9)}`,
    EMAIL: (r) => `${pick(r, MAIL_WORD)}${r() < 0.5 ? "." : "_"}${pick(r, MAIL_WORD)}${int(r, 1, 99)}@${pick(r, DOMAIN_STEM)}.${pick(r, DOMAIN_TLD)}`,
    ADDRESS: (r) => `${pick(r, ZH_PLACE)}${pick(r, ZH_ROAD)}${int(r, 1, 399)}号${r() < 0.6 ? `${int(r, 1, 30)}栋${int(r, 1, 30)}0${int(r, 1, 9)}室` : ""}`,
    ACCOUNT: (r) => (r() < 0.7 ? `9${chars(r, "0123456789", int(r, 15, 18))}` : luhnCard(r)),
    SECRET: password,
  },
  en: {
    PERSON: (r) => `${pick(r, EN_FIRST)} ${pick(r, EN_LAST)}`,
    PHONE: (r) => (r() < 0.5 ? `(${pick(r, [212, 303, 415, 617, 702])}) 555-01${chars(r, "0123456789", 2)}` : `+1-${pick(r, [212, 303, 415, 617, 702])}-555-01${chars(r, "0123456789", 2)}`),
    EMAIL: (r) => `${pick(r, MAIL_WORD)}.${pick(r, MAIL_WORD)}${r() < 0.5 ? int(r, 1, 99) : ""}@${pick(r, DOMAIN_STEM)}.${pick(r, DOMAIN_TLD)}`,
    ADDRESS: (r) => {
      const [city, st, zip] = pick(r, EN_CITY);
      return `${int(r, 11, 9899)} ${pick(r, EN_ROAD)}${r() < 0.3 ? `, Apt ${int(r, 1, 40)}${pick(r, ["A", "B", "C"])}` : ""}, ${city}, ${st} ${zip}`;
    },
    ACCOUNT: (r) => (r() < 0.7 ? `9${chars(r, "0123456789", int(r, 9, 12))}` : luhnCard(r)),
    SECRET: password,
  },
};

function luhnCard(r: Rand): string {
  const body = `400000${chars(r, "0123456789", 9)}`;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const full = body + String((10 - (sum % 10)) % 10);
  return `${full.slice(0, 4)} ${full.slice(4, 8)} ${full.slice(8, 12)} ${full.slice(12)}`;
}

function password(r: Rand): string {
  const U = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const L = "abcdefghijkmnopqrstuvwxyz";
  const D = "23456789";
  const S = "!@#$%^&*?";
  const n = int(r, 10, 16);
  const cs = [pick(r, [...U]), pick(r, [...L]), pick(r, [...D]), pick(r, [...S])];
  while (cs.length < n) cs.push(pick(r, [...(U + L + D + S)]));
  for (let i = cs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [cs[i], cs[j]] = [cs[j]!, cs[i]!];
  }
  // 不以可能像密钥前缀的形状开头：首字符固定为一个大写字母加数字
  return `${pick(r, [...U])}${pick(r, [...D])}${cs.join("")}`;
}

// ---- 上下文模板（{V} 是值）----------------------------------------------------------------------

interface Tpl {
  style: string;
  t: string;
}
const T = (style: string, t: string): Tpl => ({ style, t });

const templates: Record<Lang, Record<Kind, Tpl[]>> = {
  zh: {
    PERSON: [T("sentence", "客户{V}今天下午来电反馈了配送问题。"), T("sentence", "项目负责人是{V}，有问题请直接联系。"), T("sentence", "我叫{V}，在公司负责财务对账。"), T("sentence", "会议纪要：{V}提出了新的排期方案。"), T("field", "收件人：{V}"), T("field", "联系人: {V}"), T("json", '"name": "{V}"')],
    PHONE: [T("field", "联系电话：{V}"), T("sentence", "请拨打{V}联系我。"), T("sentence", "手机号 {V}，微信同号。"), T("field", "手机: {V}"), T("json", '"phone": "{V}"')],
    EMAIL: [T("sentence", "邮箱是 {V}，请抄送。"), T("sentence", "发送到 {V} 即可。"), T("field", "Email: {V}"), T("field", "邮箱：{V}"), T("json", '"email": "{V}"')],
    ADDRESS: [T("field", "收货地址：{V}"), T("sentence", "公司位于{V}，请按时到达。"), T("sentence", "请把发票寄到{V}。"), T("field", "地址: {V}"), T("json", '"address": "{V}"')],
    ACCOUNT: [T("field", "银行卡号：{V}"), T("sentence", "请转账到账号 {V}。"), T("field", "收款账号: {V}"), T("sentence", "卡号 {V}，开户行已确认。"), T("env", "ACCOUNT_NO={V}")],
    SECRET: [T("sentence", "密码是 {V}，不要外传。"), T("env", "DB_PASSWORD={V}"), T("json", '"password": "{V}"'), T("field", "登录口令：{V}"), T("field", "Password: {V}")],
  },
  en: {
    PERSON: [T("sentence", "Customer {V} called this afternoon about the delivery."), T("sentence", "The project lead is {V}; contact them directly for questions."), T("sentence", "My name is {V} and I handle the billing reconciliation."), T("sentence", "Meeting notes: {V} proposed a new schedule."), T("field", "Recipient: {V}"), T("field", "Contact: {V}"), T("json", '"name": "{V}"')],
    PHONE: [T("field", "Phone: {V}"), T("sentence", "Please call {V} to reach me."), T("sentence", "My mobile number is {V}, text me anytime."), T("field", "Mobile: {V}"), T("json", '"phone": "{V}"')],
    EMAIL: [T("sentence", "My email is {V}, please keep me in copy."), T("sentence", "Just send it to {V} and we are done."), T("field", "Email: {V}"), T("field", "Reply-To: {V}"), T("json", '"email": "{V}"')],
    ADDRESS: [T("field", "Shipping address: {V}"), T("sentence", "Our office is at {V}, please arrive on time."), T("sentence", "Mail the invoice to {V}."), T("field", "Address: {V}"), T("json", '"address": "{V}"')],
    ACCOUNT: [T("field", "Bank account number: {V}"), T("sentence", "Please transfer the funds to account {V}."), T("field", "Card number: {V}"), T("sentence", "The card {V} was confirmed by the bank."), T("env", "ACCOUNT_NO={V}")],
    SECRET: [T("sentence", "The password is {V}, do not share it."), T("env", "DB_PASSWORD={V}"), T("json", '"password": "{V}"'), T("field", "Login passphrase: {V}"), T("field", "Password: {V}")],
  },
};

// ---- 背景文本（不含个人信息；含一些容易被误遮的东西：snake_case、版本号、模块名、URL、文件名）--------------

const ZH_SUBJ = ["订单服务", "支付模块", "缓存层", "搜索接口", "报表任务", "登录流程", "通知中心", "文件上传", "定时任务", "权限校验"];
const ZH_ACT = ["完成了压测", "合并了重构", "修复了超时问题", "升级了依赖", "补充了单元测试", "调整了重试策略", "上线了灰度发布", "回滚了一个变更", "更新了监控看板", "梳理了接口文档"];
const ZH_TAIL = ["，错误率明显下降。", "，下周继续观察。", "，需要在评审会上再确认。", "，没有发现新的告警。", "，相关记录已写入工单。", "。"];
const EN_SUBJ = ["The order service", "The payment module", "The cache layer", "The search endpoint", "The nightly report job", "The login flow", "The notification hub", "The upload pipeline", "The scheduler", "The permission check"];
const EN_ACT = ["finished load testing", "merged the refactor", "fixed the timeout issue", "upgraded its dependencies", "gained more unit tests", "adopted a new retry policy", "rolled out to a canary group", "reverted one change", "updated the dashboard", "got its API docs cleaned up"];
const EN_TAIL = [", and the error rate dropped noticeably.", "; we will keep watching it next week.", ", which still needs confirmation in the review.", " without any new alerts.", ", and the notes are in the ticket.", "."];
const TECH = ["user_profile_service", "retry_with_backoff", "max_connections", "build_artifact_cache", "v2.14.3", "release-2026.03", "src/utils/format_date.ts", "config/settings.yaml", "https://docs.acme-widgets.dev/guide/retry", "import fastapi from 'fastapi'", "lodash/debounce", "npm install left-pad@1.3.0", "kubectl rollout status deploy/api-gateway", "order_id=48213907", "trace-9f2c1a7b"];

function backgroundSentence(r: Rand, lang: Lang): string {
  if (r() < 0.22) return lang === "zh" ? `相关代码在 ${pick(r, TECH)}，请对照查看。` : `Related code lives in ${pick(r, TECH)}; please compare it.`;
  return lang === "zh" ? `${pick(r, ZH_SUBJ)}${pick(r, ZH_ACT)}${pick(r, ZH_TAIL)}` : `${pick(r, EN_SUBJ)} ${pick(r, EN_ACT)}${pick(r, EN_TAIL)}`;
}

/** 纯背景段落（无个人信息），约 bytes 字节。 */
export function background(r: Rand, lang: Lang, bytes: number): string {
  const lines: string[] = [];
  let n = 0;
  while (n < bytes) {
    const s = backgroundSentence(r, lang);
    lines.push(s);
    n += Buffer.byteLength(s) + 1;
  }
  return lines.join(lang === "zh" ? "" : " ");
}

// ---- 带标注的段落 -------------------------------------------------------------------------------

const KINDS: readonly Kind[] = ["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT", "SECRET"];

/**
 * 生成标注语料：每个 (语言, 类别) 恰好 perKind 个值。每个段落由 3 句背景夹 2–4 个值的句子组成，行与行之间用换行分隔。
 */
export function annotated(seed: number, perKind: number): Doc[] {
  const r = rng(seed);
  const docs: Doc[] = [];
  for (const lang of ["zh", "en"] as const) {
    const queue: Kind[] = [];
    for (const k of KINDS) for (let i = 0; i < perKind; i++) queue.push(k);
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [queue[i], queue[j]] = [queue[j]!, queue[i]!];
    }
    while (queue.length > 0) {
      const n = Math.min(queue.length, int(r, 2, 4));
      let text = "";
      const planted: Planted[] = [];
      const bg = (): void => {
        text += backgroundSentence(r, lang) + (lang === "zh" ? "" : " ");
      };
      bg();
      bg();
      text += "\n";
      for (let i = 0; i < n; i++) {
        const kind = queue.pop()!;
        const value = makers[lang][kind](r);
        const tpl = pick(r, templates[lang][kind]);
        const [pre, post] = tpl.t.split("{V}") as [string, string];
        text += pre;
        planted.push({ start: text.length, end: text.length + value.length, kind, lang, style: tpl.style, value });
        text += value + post + "\n";
        if (r() < 0.5) {
          bg();
          text += "\n";
        }
      }
      bg();
      docs.push({ text, planted });
    }
  }
  return docs;
}

// ---- 速度用的内容类型 ----------------------------------------------------------------------------

/** 模拟工具输出：搜索结果 JSON（路径、行号、片段、id），不含个人信息。 */
export function jsonToolOutput(r: Rand, bytes: number): string {
  const dirs = ["src", "lib", "internal/service", "pkg/util", "cmd/server", "web/components", "tests/integration"];
  const names = ["handler", "router", "cache", "store", "client", "parser", "worker", "config", "queue", "metrics"];
  const exts = ["ts", "go", "py", "rs"];
  const rows: string[] = [];
  let n = 0;
  while (n < bytes) {
    const path = `${pick(r, dirs)}/${pick(r, names)}_${pick(r, names)}.${pick(r, exts)}`;
    const row = JSON.stringify(
      { id: `m_${chars(r, "0123456789abcdef", 12)}`, path, line: int(r, 1, 900), score: Number(r().toFixed(4)), snippet: `func ${pick(r, names)}${int(r, 1, 99)}(ctx context.Context, opts *Options) error { return run(ctx, opts) }`, tags: [pick(r, names), pick(r, names)] },
      null,
      2,
    );
    rows.push(row);
    n += row.length + 2;
  }
  return `{"query":"retry","total":${rows.length},"results":[\n${rows.join(",\n")}\n]}`;
}
