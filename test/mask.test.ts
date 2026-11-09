import { describe, expect, test } from "bun:test";
import { defaultConfig, type Config } from "../src/config.ts";
import { Lru, MaskTimeout, Masker, isBlob, protectedRanges, sha, trimProtected } from "../src/mask.ts";
import { Placeholders } from "../src/placeholder.ts";
import { FakeRecognizer, VALUES } from "./fake.ts";

function setup(values: Record<string, string> = VALUES, over: Partial<Config> = {}) {
  const rec = new FakeRecognizer(values);
  const cfg = { ...defaultConfig(), ...over };
  const ph = new Placeholders(() => Buffer.alloc(32, 7));
  const masker = new Masker(async () => rec, ph, () => cfg);
  return { rec, cfg, ph, masker };
}

const t = (text: string, args = false) => ({ text, args });

describe("遮挡管线", () => {
  test("模型找到的值换成占位符，往返还原一致", async () => {
    const { masker, ph } = setup();
    const text = "联系人张伟，手机 13812345678，邮箱 zhangwei@acme-corp.cn，地址上海市浦东新区张江路500号。";
    const [out] = await masker.maskTexts([t(text)]);
    expect(out).not.toContain("13812345678");
    expect(out).not.toContain("zhangwei@acme-corp.cn");
    expect(out).not.toContain("张江路");
    expect(out).toMatch(/\{\{PHONE_[a-z2-7]{8}\}\}/);
    expect(out).toMatch(/\{\{EMAIL_[a-z2-7]{8}\}\}/);
    expect(out).toMatch(/\{\{ADDRESS_[a-z2-7]{8}\}\}/);
    expect(ph.restoreText(out!)).toBe(text);
  });

  test("emoji / 生僻字之后的偏移正确", async () => {
    const { masker, ph } = setup();
    const text = "😀𠮷 手机 13812345678 😀";
    const [out] = await masker.maskTexts([t(text)]);
    expect(out).toMatch(/^😀𠮷 手机 \{\{PHONE_[a-z2-7]{8}\}\} 😀$/);
    expect(ph.restoreText(out!)).toBe(text);
  });

  test("同一文本只推理一次；遮挡产出再遇到不再推理（第二层不重复）", async () => {
    const { masker, rec } = setup();
    const text = "手机 13812345678";
    const [out] = await masker.maskTexts([t(text)]);
    expect(rec.calls.length).toBe(1);
    await masker.maskTexts([t(text)]);
    expect(rec.calls.length).toBe(1);
    expect(await masker.maskTexts([t(out!)])).toEqual([out!]);
    expect(rec.calls.length).toBe(1); // 遮挡产出命中“已遮挡”缓存
  });

  test("同批相同文本只推理一次", async () => {
    const { masker, rec } = setup();
    const outs = await masker.maskTexts([t("手机 13812345678"), t("手机 13812345678"), t("手机 13812345678", true)]);
    expect(rec.calls.length).toBe(1);
    expect(new Set(outs).size).toBe(1);
  });

  test("已知值补遮：模型在别处没找到的同一个值也遮", async () => {
    const { masker, rec } = setup();
    // 第一段由模型找到邮箱；第二段里模型什么也找不到（假识别器只在含“邮箱”的文本里报告）
    const orig = rec.find.bind(rec);
    rec.find = async (text: string) => (text.includes("邮箱") ? orig(text) : []);
    const a = "邮箱 zhangwei@acme-corp.cn";
    const b = "转发给 zhangwei@acme-corp.cn 即可";
    const [oa, ob] = await masker.maskTexts([t(a), t(b)]);
    expect(oa).not.toContain("zhangwei@acme-corp.cn");
    expect(ob).not.toContain("zhangwei@acme-corp.cn");
    expect(oa!.match(/\{\{EMAIL_[a-z2-7]{8}\}\}/)![0]).toBe(ob!.match(/\{\{EMAIL_[a-z2-7]{8}\}\}/)![0]);
  });

  test("回溯补遮：值先出现在缓存里的旧文本、后来才被模型认出 → 旧文本下次重算", async () => {
    const { masker, rec } = setup();
    const orig = rec.find.bind(rec);
    rec.find = async (text: string) => (text.includes("邮箱") ? orig(text) : []);
    const old = "旧的：zhangwei@acme-corp.cn";
    const [o1] = await masker.maskTexts([t(old)]);
    expect(o1).toBe(old); // 此时还没人认出它
    await masker.maskTexts([t("邮箱 zhangwei@acme-corp.cn")]);
    const [o2] = await masker.maskTexts([t(old)]);
    expect(o2).not.toContain("zhangwei@acme-corp.cn");
  });

  test("同一批里先出现的文本也被后出现文本发现的值补遮", async () => {
    const { masker, rec } = setup();
    const orig = rec.find.bind(rec);
    rec.find = async (text: string) => (text.includes("邮箱") ? orig(text) : []);
    const [a, b] = await masker.maskTexts([t("旧的：zhangwei@acme-corp.cn"), t("邮箱 zhangwei@acme-corp.cn")]);
    expect(a).not.toContain("zhangwei@acme-corp.cn");
    expect(b).not.toContain("zhangwei@acme-corp.cn");
  });

  test("落在 $$…$$ 与映射表里 {{…}} 里的 span 丢弃，占位符原样保留", async () => {
    const { masker, ph } = setup({ ABCD1234EFGH: "common_secret", abcdefgh: "common_secret" });
    ph.byPh.set("{{PERSON_abcdefgh}}", "某人"); // 映射表里确实有的占位符
    const text = "key $$ABCD1234EFGH:L$$ 和 {{PERSON_abcdefgh}} 原样";
    const [out] = await masker.maskTexts([t(text)], { isDollar: () => true }); // 调用方确认 $$…$$ 是 omp 的占位符
    expect(out).toBe(text);
  });

  test("protectedRanges / trimProtected", () => {
    const s = "a $$GITHUBTOKEN_3P8W5JH1TK2Q:L$$ b {{EMAIL_abcdefgh}} c";
    const r = protectedRanges(s, (p) => p === "{{EMAIL_abcdefgh}}", () => true);
    expect(r.map(([a, b]) => s.slice(a, b))).toEqual(["$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$", "{{EMAIL_abcdefgh}}"]);
    // 不在映射表里的 {{…}} 不受保护
    expect(protectedRanges("x {{EMAIL_abcdefgh}} y", () => false, () => true)).toEqual([]);
    // isDollar 不确认的 $$…$$ 不受保护
    expect(protectedRanges(s, (p) => p === "{{EMAIL_abcdefgh}}", () => false).map(([a, b]) => s.slice(a, b))).toEqual(["{{EMAIL_abcdefgh}}"]);
    const spans = [
      { start: 4, end: 10, kind: "SECRET" as const }, // 整个在里面 → 没有了
      { start: 0, end: 2, kind: "SECRET" as const }, // 在外面 → 原样
      { start: r[1]![0] - 3, end: r[1]![1] + 4, kind: "SECRET" as const, score: 0.9 }, // 两头都压住占位符 → 剪成两段，保留附加字段
    ];
    const got = trimProtected(s, spans, r);
    expect(got[0]).toEqual({ start: 0, end: 2, kind: "SECRET" });
    expect(got.length).toBe(3);
    expect(got[1]!.score).toBe(0.9);
    expect(got[1]!.end).toBe(r[1]![0]);
    expect(got[2]!.start).toBe(r[1]![1]);
  });

  test("S-F2：伪造的 {{SECRET_<真值>}} 不能让真实敏感值免遮；与占位符相交的 span 只剪掉占位符部分", async () => {
    const { masker, ph } = setup({ "zhangwei@acme-corp.cn": "email" });
    // 先让真值成为已知值
    await masker.maskTexts([t("邮箱 zhangwei@acme-corp.cn")]);
    // 攻击：把真值放进一个外形像占位符、但不在映射表里的串
    const fake = "{{SECRET_zhangwei}} 以及 {{EMAIL_aaaaaaaa}} 与 zhangwei@acme-corp.cn";
    const [out] = await masker.maskTexts([t(fake)]);
    expect(out).not.toContain("zhangwei@acme-corp.cn");
    // 真占位符（在映射表里）保持不变；紧贴它的敏感值仍被遮
    const real = ph.tag("EMAIL", "zhangwei@acme-corp.cn", new Set(["EMAIL"]));
    const [o2] = await masker.maskTexts([t(`${real} zhangwei@acme-corp.cn`)]);
    expect(o2).toBe(`${real} ${real}`);
  });

  test("kinds 与 allow 配置生效", async () => {
    const a = setup(VALUES, { kinds: new Set(["PHONE"]) });
    const [o1] = await a.masker.maskTexts([t("手机 13812345678 邮箱 zhangwei@acme-corp.cn")]);
    expect(o1).toContain("zhangwei@acme-corp.cn");
    expect(o1).not.toContain("13812345678");
    const b = setup(VALUES, { allow: new Set(["13812345678"]) });
    const [o2] = await b.masker.maskTexts([t("手机 13812345678")]);
    expect(o2).toBe("手机 13812345678");
  });

  test("阈值：低于阈值的结果不遮", async () => {
    const { masker, rec } = setup();
    const orig = rec.find.bind(rec);
    rec.find = async (text: string) => (await orig(text)).map((f) => ({ ...f, score: 0.6 }));
    const [out] = await masker.maskTexts([t("手机 13812345678")]);
    expect(out).toBe("手机 13812345678");
  });

  test("太短与二进制样的长串不推理", async () => {
    const { masker, rec } = setup();
    const blob = "A".repeat(2000);
    await masker.maskTexts([t(""), t("a"), t(blob)]);
    expect(rec.calls.length).toBe(0);
    expect(isBlob(blob)).toBe(true);
    expect(isBlob("A ".repeat(2000))).toBe(false);
    expect(isBlob("B".repeat(500))).toBe(false);
  });

  test("S-F4：长串只跳过推理，已知值补遮照做", async () => {
    const { masker, rec } = setup();
    await masker.maskTexts([t("手机 13812345678")]); // 使号码成为已知值
    const n = rec.calls.length;
    const pure = `${"A".repeat(600)}-13812345678-${"B".repeat(600)}`;
    expect(isBlob(pure)).toBe(true);
    const [o1] = await masker.maskTexts([t(pure)]);
    expect(o1).toMatch(/^A{600}-\{\{PHONE_[a-z2-7]{8}\}\}-B{600}$/);
    expect(rec.calls.length).toBe(n); // 长串没有送模型
  });

  test("R-P1/S-F6：缓存键含 args——同一文本在不同语境下各自判定，不能互相放行", async () => {
    const { masker, rec } = setup({ Rina: "private_person" });
    const text = "using Rina";
    const [a] = await masker.maskTexts([t(text, false)]);
    const [b] = await masker.maskTexts([t(text, true)]);
    expect(a).toBe(text); // 文本语境：作为应用名放行（T2 的 args 规则）
    expect(b).not.toContain("Rina"); // 工具参数语境：照遮
    const fresh = setup({ Rina: "private_person" });
    expect((await fresh.masker.maskTexts([t(text, true)]))[0]).toBe(b!);
    expect(rec.calls.length).toBe(1); // 识别结果只推理一次，两种语境共用
  });

  test("R-P1：有改动的产出在同语境下免重复识别，但换语境不命中", async () => {
    const { masker, rec } = setup();
    const [out] = await masker.maskTexts([t("手机 13812345678", false)]);
    const n = rec.calls.length;
    await masker.maskTexts([t(out!, false)]);
    expect(rec.calls.length).toBe(n);
    await masker.maskTexts([t(out!, true)]);
    expect(rec.calls.length).toBe(n + 1); // 另一语境：按文本重新识别
  });

  test("R-P2：已知值按分数与阈值过滤——调高阈值后旧的低分值不再补遮", async () => {
    const { masker, rec, cfg, ph } = setup();
    const orig = rec.find.bind(rec);
    rec.find = async (text: string) => (text.includes("手机") ? (await orig(text)).map((f) => ({ ...f, score: 0.85 })) : []);
    const [o1] = await masker.maskTexts([t("手机 13812345678")]);
    expect(o1).toContain("{{PHONE_");
    const [o2] = await masker.maskTexts([t("转给 13812345678 吧")]); // 模型没找到，靠已知值补遮
    expect(o2).toContain("{{PHONE_");
    cfg.threshold = 0.95;
    masker.configChanged(); // 重读配置
    const [o3] = await masker.maskTexts([t("转给 13812345678 吧")]);
    expect(o3).toBe("转给 13812345678 吧");
    const [o4] = await masker.maskTexts([t("手机 13812345678")]); // 模型分数 0.85 < 0.95
    expect(o4).toBe("手机 13812345678");
    expect(ph.restoreText(o1!)).toBe("手机 13812345678"); // 映射还在，还原不受影响
  });

  test("预扫描把识别结果放进缓存，出口不再推理", async () => {
    const { masker, rec } = setup();
    await masker.prescan([t("手机 13812345678")]);
    expect(rec.calls.length).toBe(1);
    const [out] = await masker.maskTexts([t("手机 13812345678")]);
    expect(rec.calls.length).toBe(1);
    expect(out).toContain("{{PHONE_");
  });
});

describe("时限与失败", () => {
  test("超过截止时间抛 MaskTimeout；后台推理继续，下次直接命中", async () => {
    const { masker, rec } = setup();
    rec.delayMs = 120;
    const p = masker.maskTexts([t("手机 13812345678")], { deadline: Date.now() + 20 });
    await expect(p).rejects.toBeInstanceOf(MaskTimeout);
    await new Promise((r) => setTimeout(r, 200));
    const [out] = await masker.maskTexts([t("手机 13812345678")], { deadline: Date.now() + 20 });
    expect(out).toContain("{{PHONE_");
    expect(rec.calls.length).toBe(1);
  });

  test("已过的截止时间：有未缓存文本就抛，全部命中缓存则不抛", async () => {
    const { masker } = setup();
    await masker.maskTexts([t("手机 13812345678")]);
    const [out] = await masker.maskTexts([t("手机 13812345678")], { deadline: Date.now() - 1 });
    expect(out).toContain("{{PHONE_");
    await expect(masker.maskTexts([t("另一段 13812345678 xx")], { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(MaskTimeout);
  });

  test("识别失败 → 抛错、不返回原文；之后恢复可用", async () => {
    const { masker, rec } = setup();
    rec.failWith = new Error("模型坏了");
    await expect(masker.maskTexts([t("手机 13812345678")])).rejects.toThrow("模型坏了");
    rec.failWith = undefined;
    const [out] = await masker.maskTexts([t("手机 13812345678")]);
    expect(out).toContain("{{PHONE_");
  });

  test("识别器加载失败（模型缺失）→ 抛错", async () => {
    const ph = new Placeholders(() => Buffer.alloc(32, 1));
    const masker = new Masker(async () => Promise.reject(new Error("模型文件不可用")), ph, () => defaultConfig());
    await expect(masker.maskTexts([t("手机 13812345678")])).rejects.toThrow("模型文件不可用");
  });
});

describe("Lru", () => {
  test("按条数与权重淘汰最久未用的", () => {
    const l = new Lru<number>(3, 100);
    l.set("a", 1, 10);
    l.set("b", 2, 10);
    l.set("c", 3, 10);
    l.get("a");
    l.set("d", 4, 10);
    expect(l.get("b")).toBeUndefined();
    expect(l.get("a")).toBe(1);
    l.set("e", 5, 95);
    expect(l.size).toBe(1);
    expect(sha("x")).toBe(sha("x"));
    expect(sha("x")).not.toBe(sha("y"));
  });
});

import { Limiter } from "../src/guard.ts";

describe("Limiter", () => {
  test("并发不超过上限；前台排在后台前面；不会因交接超发", async () => {
    const lim = new Limiter(2);
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const job = (name: string, background = false) =>
      lim.run(async () => {
        running++;
        peak = Math.max(peak, running);
        order.push(name);
        await new Promise((r) => setTimeout(r, 15));
        running--;
      }, background);
    const all = [job("a"), job("b"), job("bg1", true), job("bg2", true), job("fg1"), job("fg2")];
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(order.slice(0, 2)).toEqual(["a", "b"]);
    expect(order.slice(2, 4)).toEqual(["fg1", "fg2"]); // 后到的前台先于先到的后台
    expect(order.slice(4)).toEqual(["bg1", "bg2"]);
    // 空闲后再来仍然能跑
    await lim.run(async () => {});
  });
});

describe("返工第 1 轮：$$…$$ 严格格式（S-F2）", () => {
  const D = "$".repeat(2);
  const ph = (inner: string) => `${D}${inner}${D}`;

  test("只保护严格符合 omp 占位符格式的 $$…$$", () => {
    const valid = [ph("GITHUBTOKEN_3P8W5JH1TK2Q:L"), ph("ABCD1234EFGH"), ph("3P8W5JH1TK2Q"), ph(`${"A".repeat(32)}_ABCD1234EFGH:Z`)];
    const invalid = [
      ph("Zq8hunterPass42"),
      ph("hunterpass99"),
      ph("ABCD1234EFG"), // 11 位
      ph("ABCD1234EFGHI"), // 13 位
      ph("ABCD1234EFGH:l"),
      ph("ABCD1234EFGH:LL"),
      ph("abc_ABCD1234EFGH"),
      ph(`${"A".repeat(33)}_ABCD1234EFGH`),
      ph("GITHUB TOKEN_ABCD1234EFGH"),
    ];
    for (const v of valid) expect(protectedRanges(`x ${v} y`, () => false, () => true).map(([a, b]) => `x ${v} y`.slice(a, b))).toEqual([v]);
    for (const v of invalid) expect(protectedRanges(`x ${v} y`, () => false, () => true)).toEqual([]);
  });

  test("$$<已知值>$$：已知值补遮不受占位符保护影响，伪造格式的也不被保护", async () => {
    const seed = "Zq8hunterPass42";
    const { masker, rec } = setup({ [seed]: "common_secret", ABCD1234EFGH: "common_secret" });
    await masker.maskTexts([t(`密码 ${seed} 与令牌 ABCD1234EFGH`)]); // 使它们成为已知值
    const n = rec.calls.length;
    for (const v of [seed, "ABCD1234EFGH"]) {
      const [o] = await masker.maskTexts([t(`before ${ph(v)} after ${v}`)]);
      expect(o).not.toContain(v);
      expect(o!.match(/\{\{SECRET_[a-z2-7]{8}\}\}/g)!.length).toBe(2);
    }
    expect(rec.calls.length).toBe(n + 2); // 新文本各推理一次，别无多余
  });

  test("模型只把占位符本身当成密钥：整段在保护区内，不登记成已知值", async () => {
    const real = ph("GITHUBTOKEN_3P8W5JH1TK2Q:L");
    const { masker, ph: table } = setup({ "GITHUBTOKEN_3P8W5JH1TK2Q": "common_secret" });
    const text = `token ${real} 完`;
    const [o] = await masker.maskTexts([t(text)], { isDollar: () => true });
    expect(o).toBe(text);
    expect(table.known.size).toBe(0);
  });
});

describe("返工第 2 轮：$$…$$ 按来源信任（S-F2）", () => {
  const D = "$".repeat(2);
  const dollar = (inner: string) => `${D}${inner}${D}`;
  const real = dollar("Q7M2Z8P4R6T9"); // 符合严格格式的 12 位大写字母数字：既可能是 omp 占位符，也可能是用户写下的真实密码

  test("首次出现、符合严格格式、但调用方不确认（本地历史里字面出现过）：模型识别出的密码照遮，不进已知值前就被剪掉", async () => {
    const { masker, ph } = setup({ Q7M2Z8P4R6T9: "common_secret" });
    const [o] = await masker.maskTexts([t(`密码 ${real}`)], { isDollar: () => false });
    expect(o).not.toContain("Q7M2Z8P4R6T9");
    expect(o).toMatch(/\{\{SECRET_[a-z2-7]{8}\}\}/);
    expect(ph.known.size).toBe(1);
  });

  test("没有 isDollar（缺省）等于一个都不保护；确认的才保护，保护状态不同，缓存产出不同", async () => {
    const { masker } = setup({ Q7M2Z8P4R6T9: "common_secret" });
    const text = `密码 ${real}`;
    const [kept] = await masker.maskTexts([t(text)], { isDollar: (p) => p === real });
    expect(kept).toBe(text); // 确认是 omp 的占位符：保护
    const [a] = await masker.maskTexts([t(text)]);
    expect(a).not.toContain("Q7M2Z8P4R6T9"); // 同一文本，不再确认：照遮（不能吃上一次的缓存）
    const [b] = await masker.maskTexts([t(text)], { isDollar: (p) => p === real });
    expect(b).toBe(a); // 已知值补遮不受保护影响
  });

  test("确认的 $$…$$ 保护；别的严格格式串不确认照遮；确认状态变化后缓存不串", async () => {
    const other = dollar("ZZ9Y8X7W6V5U");
    const { masker } = setup({ ZZ9Y8X7W6V5U: "common_secret", Q7M2Z8P4R6T9: "common_secret" });
    const text = `${real} 与 ${other}`;
    const [o] = await masker.maskTexts([t(text)], { isDollar: (p) => p === real });
    expect(o).toContain(real);
    expect(o).not.toContain("ZZ9Y8X7W6V5U");
  });

  test("真实模型把整个 $$<值>$$（连两侧的 $$）当成一个密码给出：不确认的去掉 $$ 后照遮；确认的整段保留", async () => {
    const { masker, rec } = setup({});
    // 与真实模型一致：区间是整个 $$Q7M2Z8P4R6T9$$，不是里面的值
    rec.find = async (text: string) => {
      const at = text.indexOf(real);
      return at < 0 ? [] : [{ start: at, end: at + real.length, label: "common_secret", score: 0.976 }];
    };
    const text = `我的数据库登录密码是 ${real}，请复述。`;
    const [kept] = await masker.maskTexts([t(text)], { isDollar: (p) => p === real });
    expect(kept).toBe(text); // 确认是 omp 的占位符
    const [o] = await masker.maskTexts([t(text)], { isDollar: () => false });
    expect(o).not.toContain("Q7M2Z8P4R6T9");
    expect(o).toMatch(/^我的数据库登录密码是 \$\$\{\{SECRET_[a-z2-7]{8}\}\}\$\$，请复述。$/);
    // 之后在别处出现（已知值）也遮
    const [again] = await masker.maskTexts([t(`另一处 Q7M2Z8P4R6T9`)], { isDollar: () => false });
    expect(again).not.toContain("Q7M2Z8P4R6T9");
  });
});

describe("返工第 1 轮：两字中文名补遮（裁决 6）", () => {
  test("模型在一处高分找到 张伟，另一处只给低分：第二处照遮；调高阈值后不再补遮", async () => {
    const { masker, rec, cfg } = setup();
    const orig = rec.find.bind(rec);
    rec.find = async (text: string) => (await orig(text)).map((f) => ({ ...f, score: text.startsWith("我叫") ? 0.95 : 0.3 }));
    const [a] = await masker.maskTexts([t("我叫张伟，请记住")]);
    expect(a).toMatch(/^我叫\{\{PERSON_[a-z2-7]{8}\}\}，请记住$/);
    const [b] = await masker.maskTexts([t("稍后张伟会来，请转告张伟。")]); // 模型只给 0.3，过不了阈值
    expect(b).not.toContain("张伟");
    expect(b!.match(/\{\{PERSON_[a-z2-7]{8}\}\}/g)!.length).toBe(2);
    cfg.threshold = 0.99;
    masker.configChanged();
    const [c] = await masker.maskTexts([t("稍后张伟会来，请转告张伟。")]);
    expect(c).toBe("稍后张伟会来，请转告张伟。"); // 0.95 < 0.99：旧值不再补遮
  });
});
