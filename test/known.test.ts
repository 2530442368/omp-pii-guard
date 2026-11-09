// 移植自 magpie internal/redact 的 known_test.go、package_known_test.go、package_words_test.go、
// zhword_known_test.go、decimal_test.go、ids_test.go 里与 knownSpans 有关的用例。
// magpie 的已知值是进程级全局状态（遮过一次的值自动成为已知值），这里由调用方传入 Map。

import { describe, expect, test } from "bun:test";
import { knownSpans } from "../src/known.ts";
import { type Kind } from "../src/filters.ts";
import { covered } from "./helpers.ts";

const known = (entries: Record<string, Kind>): Map<string, Kind> => new Map(Object.entries(entries) as [string, Kind][]);

describe("known_test.go", () => {
  const secret = "Zq8hunterPass42";
  const email = "rina.k@acme-labs.io";
  const phone = "13912345670";
  const k = known({ [secret]: "SECRET", [email]: "EMAIL", [phone]: "PHONE" });

  test("TestKnownValueMaskedInOtherWords：供应商用自己的话回答，已知值仍被遮", () => {
    const reply = `Your password is ${secret}, and I will write to ${email}. Or call ${phone}!`;
    const sp = knownSpans(reply, k);
    expect(covered(reply, sp)).toEqual([secret, email, phone]);
    expect(sp.map((x) => x.kind)).toEqual(["SECRET", "EMAIL", "PHONE"]);
  });

  test("TestKnownValueMaskedInOtherWords：更长号码或地址的一截是另一个值", () => {
    for (const s of [`order 2${phone}`, `order ${phone}9`, `mail ${email}.cn now`, `mail x${email}`]) {
      expect(knownSpans(s, k)).toEqual([]);
    }
  });

  test("TestKnownValueMaskedInOtherWords：别的标点里仍是密钥，在更长的词里是另一个词", () => {
    const s = "`" + secret + "`/" + secret + "_v2";
    expect(covered(s, knownSpans(s, k))).toEqual([secret, secret]);
    expect(knownSpans(`pass${secret}x`, k)).toEqual([]);
  });

  test("邮箱：句号结束句子仍匹配，a.b@c.com.cn 是另一个地址", () => {
    expect(covered(`write to ${email}.`, knownSpans(`write to ${email}.`, k))).toEqual([email]);
    expect(knownSpans(`${email}.cn`, k)).toEqual([]);
    expect(knownSpans(`${email}-x`, k)).toEqual([]);
  });

  test("TestShortValueNotMaskedEverywhere：短值不按已知值遮", () => {
    expect(knownSpans("hex ab12cd0 and ab12cd", known({ ab12cd: "SECRET" }))).toEqual([]);
    // 8 字节起算：3 个汉字（9 字节）会匹配；2 个汉字（6 字节）的 PERSON 另有豁免（见下），其他类别不会
    expect(covered("联系张伟明", knownSpans("联系张伟明", known({ 张伟明: "PERSON" })))).toEqual(["张伟明"]);
    expect(knownSpans("联系张伟", known({ 张伟: "SECRET" }))).toEqual([]);
  });

  test("两字中文名（PERSON，已过阈值的已知值）豁免 MIN_KNOWN：第二处低分也被补遮", () => {
    const m = known({ 张伟: "PERSON" });
    const s = "我叫张伟，稍后张伟会来，请转告张伟。";
    expect(covered(s, knownSpans(s, m))).toEqual(["张伟", "张伟", "张伟"]);
    // 2–4 个汉字才豁免；带非汉字的、更长的、其他类别的不豁免
    expect(knownSpans("联系张伟a", known({ 张伟a: "PERSON" }))).toEqual([]);
    expect(knownSpans("联系张伟", known({ 张伟: "ADDRESS" }))).toEqual([]);
  });

  test("与普通词同形的两字名字：没有角色词/称谓的语境不补遮，有就遮", () => {
    const m = known({ 方圆: "PERSON", 江山: "PERSON" });
    expect(knownSpans("这条路方圆十里没有人家", m)).toEqual([]);
    expect(knownSpans("锦绣江山如画", m)).toEqual([]);
    expect(covered("客户方圆今天到", knownSpans("客户方圆今天到", m))).toEqual(["方圆"]);
    expect(covered("江山老师说了", knownSpans("江山老师说了", m))).toEqual(["江山"]);
  });

  test("同一位置有几个已知值时取最长的", () => {
    const m = known({ "hunterpass99": "SECRET", "hunterpass99-extra1": "SECRET" });
    const s = "use hunterpass99-extra1 now and hunterpass99 later";
    expect(covered(s, knownSpans(s, m))).toEqual(["hunterpass99-extra1", "hunterpass99"]);
  });

  test("较长的已知值不满足边界时回落到较短的", () => {
    const m = known({ "Abcd1234xy": "SECRET", "Abcd1234xyzzy": "SECRET" });
    // 长的后面紧跟字母数字（Abcd1234xyzzyQ），短的 Abcd1234xy 后面是 z：都不独立
    expect(knownSpans("Abcd1234xyzzyQ", m)).toEqual([]);
    expect(covered("Abcd1234xyzzy!", knownSpans("Abcd1234xyzzy!", m))).toEqual(["Abcd1234xyzzy"]);
  });

  test("Map 内容变化后（增、改类别、删）结果随之变化，不用旧的索引", () => {
    const m = known({ [secret]: "SECRET" });
    const s = `a ${secret} b ${phone} c`;
    expect(covered(s, knownSpans(s, m))).toEqual([secret]);
    m.set(phone, "PHONE");
    expect(covered(s, knownSpans(s, m))).toEqual([secret, phone]);
    m.set(phone, "ACCOUNT");
    expect(knownSpans(s, m).map((x) => x.kind)).toEqual(["SECRET", "ACCOUNT"]);
    m.delete(secret);
    expect(covered(s, knownSpans(s, m))).toEqual([phone]);
    m.clear();
    expect(knownSpans(s, m)).toEqual([]);
  });
});

describe("package_known_test.go：已知值不遮代码加载的模块、清单依赖", () => {
  // 值里带数字，免得被“全小写词”规则先放行：这里要考的是 packageAt
  const m = known({ "drizzle-orm2": "SECRET", "jsonwebtoken9": "SECRET", "django-rest-passwordreset2": "SECRET" });

  test("TestKnownPackageNameGoesAsWrittenWhereCodeLoadsIt", () => {
    const line = "import { and, eq } from ' drizzle-orm2 '";
    expect(knownSpans(line, m)).toEqual([]);
    // 同一请求里别处的句子里仍是已知值
    expect(covered("we keep the drizzle-orm2 here", knownSpans("we keep the drizzle-orm2 here", m))).toEqual(["drizzle-orm2"]);
  });

  const placed: [string, string][] = [
    ['{\n  "dependencies": {\n    "drizzle-orm2": "^0.36.4",\n    "jsonwebtoken9": "~9.0.2"\n  }\n}', "drizzle-orm2"],
    ['"jsonwebtoken9": "workspace:*",', "jsonwebtoken9"],
    ['"drizzle-orm2": ">=0.30.0 <1",', "drizzle-orm2"],
    ['[dependencies]\njsonwebtoken9 = "9"\n', "jsonwebtoken9"],
    ["     1→import drizzle from 'drizzle-orm2';", "drizzle-orm2"],
    ["     3→import { pgTable } from 'drizzle-orm2/pg-core';", "drizzle-orm2"],
    ["+import { and, eq } from ' drizzle-orm2 '", "drizzle-orm2"],
    ["-const jwt = require('jsonwebtoken9')", "jsonwebtoken9"],
    ["node_modules/drizzle-orm2/pg-core/columns/text.d.ts:12:5 - error TS2322", "drizzle-orm2"],
    ["src/db.ts:1:27 - error TS2307: Cannot find module 'drizzle-orm2' or its corresponding type declarations.", "drizzle-orm2"],
    ["ModuleNotFoundError: No module named 'jsonwebtoken9'", "jsonwebtoken9"],
    ["pnpm add drizzle-orm2 postgres && pnpm add -D drizzle-kit", "drizzle-orm2"],
    ["npm install --save jsonwebtoken9", "jsonwebtoken9"],
    ["pip install django-rest-passwordreset2", "django-rest-passwordreset2"],
    ["added drizzle-orm2@0.36.4 to dependencies", "drizzle-orm2"],
    ["  drizzle-orm2@0.36.4:\n    resolution: {}", "drizzle-orm2"],
    ["from jsonwebtoken9 import collection", "jsonwebtoken9"],
    ["use jsonwebtoken9::{encode, Header};", "jsonwebtoken9"],
  ];
  placed.forEach(([text, value], i) => {
    test(`TestModelPackageNamesInManifestsAndOutput（已知值）#${i} ${value}`, () => {
      expect(text.includes(value)).toBe(true);
      expect(knownSpans(text, m)).toEqual([]);
    });
  });

  test("TestPackageShapesKeepSecrets：不是依赖的位置里仍遮", () => {
    const secret = known({ Zq8hunterPass42: "SECRET" });
    for (const s of ["the password from Zq8hunterPass42 there", "     1→const p = 'Zq8hunterPass42';", '{"Zq8hunterPass42": "hunter2"}', "DB_PASSWORD=Zq8hunterPass42", "login Zq8hunterPass42@10.0.0.5"]) {
      expect(covered(s, knownSpans(s, secret))).toEqual(["Zq8hunterPass42"]);
    }
  });
});

describe("package_words_test.go：TestKnownModelWordsGoAsWritten", () => {
  const dnirayBlock =
    "```ts\nexport default defineConfig({\n  entry: ['src/main.ts'],\n  format: [\n  'cjs',\n  clean: true,\n  noExternal: [/@nexus\\/shared/],\n  external: [/@nestjs/, 'reflect-metadata', 'rxjs', 'mysql2', 'drizzle-orm'],\n  sourcemap: true,\n})\n```\n";
  const m = known({ "drizzle-orm": "SECRET", "reflect-metadata": "SECRET" });
  test("只有模型找到的全小写词，已知时也原样", () => {
    expect(knownSpans(dnirayBlock, m)).toEqual([]);
    expect(knownSpans(`and now\n${dnirayBlock}`, m)).toEqual([]);
    expect(knownSpans("we keep drizzle-orm external", m)).toEqual([]);
  });
  test("被赋给密钥的名字时仍是密钥", () => {
    expect(covered("DB_PASSWORD: drizzle-orm", knownSpans("DB_PASSWORD: drizzle-orm", m))).toEqual(["drizzle-orm"]);
    expect(covered("the wifi password is reflect-metadata", knownSpans("the wifi password is reflect-metadata", m))).toEqual(["reflect-metadata"]);
  });
});

describe("zhword_known_test.go：已知的名字，原样规则不挡", () => {
  test("遮过一次的名字（即便与词同形）在没有角色词的地方仍遮", () => {
    expect(covered("白名单说明天到", knownSpans("白名单说明天到", known({ 白名单: "PERSON" })))).toEqual(["白名单"]);
    expect(covered("欧阳娜娜今天到了", knownSpans("欧阳娜娜今天到了", known({ 欧阳娜娜: "PERSON" })))).toEqual(["欧阳娜娜"]);
  });
});

describe("decimal_test.go：TestKnownNumberNotInDecimal / TestKnownSecretInDecimalStillMasked", () => {
  const phone = "13800138000";
  const m = known({ [phone]: "PHONE" });
  test("手机号不在小数的数字里", () => {
    expect(covered(`call ${phone}`, knownSpans(`call ${phone}`, m))).toEqual([phone]);
    for (const s of [`0.${phone}`, `${phone}.25`, `x=-7.${phone}e2`]) expect(knownSpans(`the value ${s} is right`, m)).toEqual([]);
  });
  test("已知的密钥在小数的数字里也遮：遮一个数比发一个密码代价小", () => {
    const sec = "Mro6tNoz4ys8Abc";
    expect(covered(`the ratio is 0.${sec}`, knownSpans(`the ratio is 0.${sec}`, known({ [sec]: "SECRET" })))).toEqual([sec]);
  });
  test("裸 JSON 数字不遮（个人信息类别）", () => {
    for (const s of ['{"n": 13800138000}', '{"ids":[13800138000, 13900139000]}', "[1, 13800138000]"]) {
      expect(knownSpans(s, known({ [phone]: "PHONE", "13900139000": "PHONE" }))).toEqual([]);
    }
    expect(covered('{"phone": "13800138000"}', knownSpans('{"phone": "13800138000"}', m))).toEqual([phone]);
  });
});

describe("ids_test.go：已知值与 id、元素令牌", () => {
  test("id 里的手机号形状是 id 的一截，已知时也不遮", () => {
    const id = "3f2b8c1e-9a4d-4e7b-b2c1-a13800138000";
    expect(knownSpans(`order ${id}`, known({ "13800138000": "PHONE" }))).toEqual([]);
  });
  test("散文里被模型标过的 s00000001，之后的 element_token 里仍原样", () => {
    const m = known({ s00000001: "SECRET" });
    expect(covered("I will click s00000001 now", knownSpans("I will click s00000001 now", m))).toEqual(["s00000001"]);
    expect(knownSpans('{\\"element_token\\":\\"s00000001\\"}', m)).toEqual([]);
    expect(knownSpans('{"element_token": "s00000001"}', known({ s00000001: "SECRET" }))).toEqual([]);
  });
});
