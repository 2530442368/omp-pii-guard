// 真模型的推理与整条管线。模型目录：PII_GUARD_TEST_MODEL_DIR，默认 magpie 的缓存；不存在则跳过。

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig } from "../src/config.ts";
import { AstrGuard, Limiter, MODEL_FILES, verifyModel } from "../src/guard.ts";
import { Masker } from "../src/mask.ts";
import { Placeholders } from "../src/placeholder.ts";

const DIR = process.env.PII_GUARD_TEST_MODEL_DIR || path.join(os.homedir(), ".cache/magpie/astrlink-guard/7216b6a3b897");
const have = MODEL_FILES.every((f) => fs.existsSync(path.join(DIR, f.name)));
const d = have ? describe : describe.skip;

let guard: AstrGuard;
beforeAll(async () => {
  if (have) guard = await AstrGuard.load(DIR, 4, new Limiter(2));
}, 60_000);

const vals = (text: string, finds: { start: number; end: number; label: string }[]) => finds.map((f) => `${f.label}:${text.slice(f.start, f.end)}`);

d("AstrLink Guard 推理", () => {
  test("找到人名、手机、邮箱、地址、密钥，偏移正确", async () => {
    const secret = `${"$".repeat(2)}ZZZZ0000YYYY:L${"$".repeat(2)}`; // omp Hide Secrets 的占位符形态
    const text = `你好，我叫张伟，手机 13812345678，邮箱 zhangwei@acme-corp.cn，住在上海市浦东新区张江路500号，密码是 ${secret}。`;
    const v = vals(text, await guard.find(text));
    expect(v).toContain("private_person:张伟");
    expect(v).toContain("phone:13812345678");
    expect(v).toContain("email:zhangwei@acme-corp.cn");
    expect(v.some((x) => x.startsWith("private_address:") && x.includes("张江路"))).toBe(true);
    expect(v.some((x) => x.startsWith("common_secret:") && x.includes("ZZZZ0000YYYY"))).toBe(true);
  });

  test("emoji / 生僻字（码点 → UTF-16 换算）", async () => {
    const text = "😀😀𠮷𠮷 我叫张伟，手机 13812345678 😀";
    const f = await guard.find(text);
    const v = vals(text, f);
    expect(v).toContain("phone:13812345678");
    expect(v).toContain("private_person:张伟");
  });

  test("超过一个窗口的长文本：开头、中间、结尾的信息都找得到", async () => {
    const filler = "这是一段没有任何个人信息的普通描述文字，用来把文本撑长。".repeat(120);
    const text = `手机 13812345678\n${filler}\n邮箱 zhangwei@acme-corp.cn\n${filler}\n我叫李四，电话 13987654321`;
    const v = vals(text, await guard.find(text));
    expect(v).toContain("phone:13812345678");
    expect(v).toContain("email:zhangwei@acme-corp.cn");
    expect(v).toContain("phone:13987654321");
  }, 30_000);

  test("空串与纯空白", async () => {
    expect(await guard.find("")).toEqual([]);
    expect(await guard.find("   ")).toEqual([]);
  });
});

d("整条管线（真模型 + 误报过滤）", () => {
  test("遮挡 → 还原往返；代码里的 snake_case 词、import 的模块名、包名不被遮", async () => {
    const ph = new Placeholders(() => Buffer.alloc(32, 3));
    const cfg = defaultConfig();
    const masker = new Masker(async () => guard, ph, () => cfg);
    const code = [
      'import { createClient } from "drizzle-orm";',
      "import sequential_cutoff from 'lodash.merge';",
      "const user_name = get_user_name(order_id);",
      "// 联系人：我叫张伟，手机 13812345678",
    ].join("\n");
    const [out] = await masker.maskTexts([{ text: code, args: false }]);
    expect(out).toContain("drizzle-orm");
    expect(out).toContain("lodash.merge");
    expect(out).toContain("sequential_cutoff");
    expect(out).toContain("get_user_name");
    expect(out).not.toContain("13812345678");
    expect(ph.restoreText(out!)).toBe(code);
  });
});

describe("verifyModel", () => {
  test("缺失、大小不符、sha256 不符都报错并指出文件", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pii-model-"));
    await expect(verifyModel(empty)).rejects.toThrow(/缺失.*model_int8\.onnx/);
    for (const f of MODEL_FILES) fs.writeFileSync(path.join(empty, f.name), "x");
    await expect(verifyModel(empty)).rejects.toThrow(/大小 1 与预期/);
    fs.rmSync(empty, { recursive: true });
    if (!have) return;
    // 同样大小但内容不同：sha256 不符
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), "pii-model-"));
    for (const f of MODEL_FILES) fs.symlinkSync(path.join(DIR, f.name), path.join(bad, f.name));
    await verifyModel(bad); // 正常
    fs.rmSync(path.join(bad, "tokenizer.json"));
    const tok = fs.readFileSync(path.join(DIR, "tokenizer.json"));
    tok[100] = tok[100]! ^ 0xff;
    fs.writeFileSync(path.join(bad, "tokenizer.json"), tok);
    await expect(verifyModel(bad)).rejects.toThrow(/sha256 不符/);
    fs.rmSync(bad, { recursive: true });
  }, 30_000);
});
