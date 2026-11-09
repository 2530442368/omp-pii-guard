// 偏移一律是 JS 的 UTF-16 码元下标。magpie 用字节下标，移植时的风险点：emoji（😀 占两个码元）、
// 生僻汉字（𠮷 在扩展 B 区，也占两个码元）出现在值前面、值里面、区间边界上。

import { describe, expect, test } from "bun:test";
import { knownSpans, MIN_KNOWN } from "../src/known.ts";
import { modelSpans, normalizeSpans, type Kind } from "../src/filters.ts";
import { zhNameSpans, zhTrim } from "../src/zhname.ts";
import { covered, fakeFind, mask, opts, spansOf } from "./helpers.ts";

const PERSONAL: ReadonlySet<Kind> = new Set<Kind>(["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT"]);

describe("modelSpans：emoji 与生僻字不改变偏移", () => {
  const text = "😀😀 Ask Rina Kowalczyk 𠮷野家 at 42 Wallaby Way, Sydney 🎉 tel 13800138000 😀 mail rina.k@kowalczyk.pl 🔑";
  const values = {
    "Rina Kowalczyk": "private_person",
    "42 Wallaby Way, Sydney": "private_address",
    "13800138000": "private_phone",
    "rina.k@kowalczyk.pl": "private_email",
  };
  test("区间切片就是模型说的那段原文", () => {
    const sp = spansOf(text, values);
    expect(covered(text, sp)).toEqual(["Rina Kowalczyk", "42 Wallaby Way, Sydney", "13800138000", "rina.k@kowalczyk.pl"]);
    expect(sp.map((x) => x.kind)).toEqual(["PERSON", "ADDRESS", "PHONE", "EMAIL"]);
    expect(mask(text, sp)).toBe("😀😀 Ask {{PERSON}} 𠮷野家 at {{ADDRESS}} 🎉 tel {{PHONE}} 😀 mail {{EMAIL}} 🔑");
    // 起点按码元数，不是码点数：前面是 😀😀（4 个码元）加 “ Ask ”（5 个）
    expect(sp[0]!.start).toBe(text.indexOf("Rina"));
    expect(sp[0]!.start).toBe(9);
  });
  test("人名里含生僻字：整个名字（4 个码点，5 个码元）都被取到", () => {
    const s = "客户𠮷田太郎反馈导出失败 😀";
    const sp = spansOf(s, { 𠮷田太郎: "private_person" }, { kinds: PERSONAL, namesByModel: false });
    expect(covered(s, sp)).toEqual(["𠮷田太郎"]);
    expect(sp[0]!.start).toBe(2);
    expect(sp[0]!.end).toBe(7);
  });
  test("区间落在代理对中间，整条丢弃", () => {
    const s = "a😀bcdefgh Rina Kowalczyk";
    const ok = { start: 11, end: 25, label: "private_person", score: 1 };
    expect(modelSpans(s, [ok], opts())).toHaveLength(1);
    // 起点在 😀 的低位代理上、终点在高位代理后、两端都切开
    for (const bad of [{ ...ok, start: 2 }, { ...ok, start: 0, end: 2 }, { ...ok, start: 2, end: 3 }]) {
      expect(modelSpans(s, [bad], opts())).toEqual([]);
    }
  });
  test("SECRET 长度按 UTF-8 字节：ab😀😀（2+4+4=10 字节）取，ab😀（6 字节）不取，ab𠮷𠮷 同理", () => {
    expect(spansOf("the vault phrase is ab😀😀", { "ab😀😀": "secret" })).toHaveLength(1);
    expect(spansOf("the vault phrase is ab😀", { "ab😀": "secret" })).toEqual([]);
    expect(spansOf("the vault phrase is ab𠮷𠮷", { "ab𠮷𠮷": "secret" })).toHaveLength(1);
  });
  test("值前面的空格被修边；前面的 emoji 不被吃进", () => {
    const s = "😀 Rina Kowalczyk";
    const sp = modelSpans(s, [{ start: 2, end: s.length, label: "private_person", score: 1 }], opts());
    expect(covered(s, sp)).toEqual(["Rina Kowalczyk"]);
  });
  test("normalizeSpans：allow 与重叠按码元处理", () => {
    const s = "😀 Rina Kowalczyk 😀 Tomasz Brzezinski";
    const a = s.indexOf("Rina");
    const b = s.indexOf("Tomasz");
    const sp = normalizeSpans(
      s,
      [
        { start: a, end: a + 14, kind: "PERSON" },
        { start: a + 5, end: a + 17, kind: "PERSON" },
        { start: b, end: s.length, kind: "PERSON" },
      ],
      new Set(["tomasz brzezinski"]),
    );
    expect(covered(s, sp)).toEqual(["Rina Kowalczyk"]);
  });
});

describe("zhNameSpans / zhTrim：emoji 与生僻字", () => {
  test("昵称补找：前面有 emoji 时偏移仍对", () => {
    const s = "😀 给小王发个消息，说老李明天不来了 𠮷";
    const sp = zhNameSpans(s, [], true);
    expect(covered(s, sp)).toEqual(["小王", "老李"]);
    expect(sp[0]!.start).toBe(s.indexOf("小王"));
  });
  test("完整线索补找：生僻字姓名", () => {
    const s = "😀😀 客户𠮷田太郎反馈";
    // 𠮷 不在姓氏表里：不补找；模型给的才算
    expect(zhNameSpans(s, [], false)).toEqual([]);
    const s2 = "😀😀 客户陈建国反馈导出失败 🎉";
    const sp = zhNameSpans(s2, [], false);
    expect(covered(s2, sp)).toEqual(["陈建国"]);
    expect(sp[0]!.start).toBe(s2.indexOf("陈建国"));
  });
  test("zhTrim：按码点数判断，边界按码元返回", () => {
    const cut = (s: string): string => {
      const [a, b] = zhTrim(s, 0, s.length);
      return s.slice(a, b);
    };
    expect(cut("𠮷田，她下周一")).toBe("𠮷田");
    expect(cut("张𠮷先生")).toBe("张𠮷");
    expect(cut("田𠮷")).toBe("田𠮷");
  });
});

describe("knownSpans：emoji 与生僻字", () => {
  test("已知值里含 emoji / 生僻字；前后是 emoji", () => {
    const secret = "密码🔑abc12345";
    const person = "𠮷田太郎";
    const k = new Map<string, Kind>([
      [secret, "SECRET"],
      [person, "PERSON"],
    ]);
    const s = `😀😀 ${secret} 😀 ${person} 😀 ${secret}`;
    const sp = knownSpans(s, k);
    expect(covered(s, sp)).toEqual([secret, person, secret]);
    expect(sp[0]!.start).toBe(5);
    expect(sp[1]!.kind).toBe("PERSON");
  });
  test("长度门槛按 UTF-8 字节：2 个 𠮷（8 字节）取，1 个 𠮷 + 1 个汉字（7 字节）不取（PERSON 的 2–4 汉字另有豁免）", () => {
    expect(MIN_KNOWN).toBe(8);
    expect(knownSpans("a 𠮷𠮷 b", new Map<string, Kind>([["𠮷𠮷", "PERSON"]]))).toHaveLength(1);
    expect(knownSpans("a 𠮷田 b", new Map<string, Kind>([["𠮷田", "ADDRESS"]]))).toEqual([]); // 4 + 3 = 7 字节
    expect(knownSpans("a 𠮷田 b", new Map<string, Kind>([["𠮷田", "PERSON"]]))).toHaveLength(1); // PERSON 汉字名豁免
  });
  test("不在代理对中间匹配：值是另一个值的后半个字符不匹配", () => {
    // “𠮷”的低位代理在字典树里只能走在高位代理之后；单独的低位代理开头的值不会在代理对中间命中
    const lone = "\uDFB7abcdefghij";
    expect(knownSpans("x𠮷abcdefghij", new Map<string, Kind>([[lone, "SECRET"]]))).toEqual([]);
  });
  test("边界字符是 emoji、汉字时，不算字母数字，值独立", () => {
    const k = new Map<string, Kind>([["Zq8hunterPass42", "SECRET"]]);
    expect(covered("🔑Zq8hunterPass42🔑", knownSpans("🔑Zq8hunterPass42🔑", k))).toEqual(["Zq8hunterPass42"]);
    // 汉字不算“字母数字”（与 magpie 一致，中文行文里值紧贴汉字也要遮）；ASCII 字母数字才算粘着
    expect(covered("密Zq8hunterPass42码", knownSpans("密Zq8hunterPass42码", k))).toEqual(["Zq8hunterPass42"]);
    expect(knownSpans("xZq8hunterPass42", k)).toEqual([]);
  });
  test("fakeFind 的偏移与 UTF-16 下标一致", () => {
    const s = "😀 x 😀 Rina Kowalczyk";
    const [f] = fakeFind(s, { "Rina Kowalczyk": "private_person" });
    expect(s.slice(f!.start, f!.end)).toBe(" Rina Kowalczyk");
  });
});
