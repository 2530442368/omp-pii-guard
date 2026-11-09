// 移植自 magpie internal/redact 的测试：model_test.go、modelfits_test.go、modelids_test.go、
// program_words_test.go、vendorchecks_test.go、hexliteral_test.go、symbol_test.go、filename_test.go、
// git_remote_test.go、decimal_test.go、token_count_test.go、userinfo_test.go、standin_ip_test.go（EVM 部分）、
// ids_test.go（模型部分）、package_*_test.go（模型部分）、email_tld_test.go（模型部分）。
//
// magpie 的测试走完整的 Mask()（规则 + 模型 + 已知值），这里只验证模型结果的过滤（modelSpans），
// 标签换成 AstrLink 的（见 helpers.ts）。“n == 0”改成“没有区间”，“不含原值”改成“区间覆盖了原值”。

import { describe, expect, test } from "bun:test";
import { epochNumber, madeID, modelSpans, modelTakes, namesThing, snakeWord, type Kind } from "../src/filters.ts";
import { ALL_KINDS, covered, fakeFind, mask, masked, opts, spansOf } from "./helpers.ts";

type Case = { text: string; value: string; label: string };

/** 区间覆盖了 value 的全部内容（遮后的文本里不再出现 value）。 */
function expectMasked(text: string, values: Record<string, string>, value: string, o = {}): void {
  expect(fakeFind(text, values).length).toBeGreaterThan(0);
  const out = masked(text, values, o);
  expect(out.includes(value)).toBe(false);
}

describe("model_test.go", () => {
  test("TestModelFindsWhatRulesDont：按类别开关遮挡", () => {
    const name = "Rina Kowalczyk";
    const addr = "42 Larchmont Ave, Springfield";
    const secret = "correct horse battery staple";
    const values = { [name]: "private_person", [addr]: "private_address", [secret]: "secret" };
    const s = `Ask ${name} at ${addr}; the vault phrase is ${secret}.`;
    const all = spansOf(s, values);
    expect(covered(s, all)).toEqual([name, addr, secret]);
    expect(all.map((x) => x.kind)).toEqual(["PERSON", "ADDRESS", "SECRET"]);
    // 值前面的空格不在区间里：占位符紧贴前面的词
    expect(mask(s, all)).toBe("Ask {{PERSON}} at {{ADDRESS}}; the vault phrase is {{SECRET}}.");
    // 个人信息关掉：名字和地址原样，密钥遮
    const secretsOnly = spansOf(s, values, { kinds: new Set<Kind>(["SECRET"]) });
    expect(covered(s, secretsOnly)).toEqual([secret]);
    // 密钥关掉
    const personalOnly = spansOf(s, values, { kinds: new Set<Kind>(["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT"]) });
    expect(covered(s, personalOnly)).toEqual([name, addr]);
    // 全关：什么也不遮
    expect(spansOf(s, values, { kinds: new Set() })).toEqual([]);
  });

  test("TestModelSpansFiltered：id、过短的密钥、单字名、不遮的标签", () => {
    const keep = {
      req_011CSzQ8mXv3kBR2: "secret",
      toolu_01AbCdEfGhIjKl: "account_number",
      hunter2: "secret",
      J: "private_person",
      "2026-10-18": "private_date",
      "https://example.org": "private_url",
    };
    const s = "see req_011CSzQ8mXv3kBR2 and toolu_01AbCdEfGhIjKl, pw hunter2, J said on 2026-10-18 at https://example.org";
    expect(spansOf(s, keep)).toEqual([]);
  });

  test("TestModelSpansFiltered：越界的区间、切开字符的区间不是区间", () => {
    // 原用例切开的是 é 的字节；UTF-16 下对应的是切开代理对（😀 占两个码元）
    const s = "a😀名字abc";
    const bad = [
      { start: -1, end: 3, label: "common_secret", score: 1 },
      { start: 0, end: 99, label: "common_secret", score: 1 },
      { start: 2, end: 6, label: "private_person", score: 1 }, // 起点在 😀 的低位代理上
      { start: 0, end: 2, label: "private_person", score: 1 }, // 终点在 😀 的高位代理后
      { start: 3, end: 3, label: "private_person", score: 1 }, // 空区间
      { start: 1.5, end: 4, label: "private_person", score: 1 }, // 非整数
    ];
    expect(modelSpans(s, bad, opts())).toEqual([]);
  });

  test("TestModelSpanLeavesDelimiters：JSON 与 CSV 里值前面的分隔符原样（#3591）", () => {
    const values = {
      '":"+86 139 1234 5678': "private_phone",
      ",+81 90-1234-5678": "private_phone",
      ",rina.k@fastmail.com": "private_email",
      '"Wei Zhang"': "private_person",
    };
    expect(masked('{"name":"Wei Zhang","phone":"+86 139 1234 5678"}', values)).toBe('{"name":"{{PERSON}}","phone":"{{PHONE}}"}');
    expect(masked("Rina,rina.k@fastmail.com,+81 90-1234-5678\n", values)).toBe("Rina,{{EMAIL}},{{PHONE}}\n");
  });
});

describe("modelfits_test.go：TestModelMisreadsNotMasked", () => {
  const cases: Case[] = [
    // 每轮带的计数
    { text: "<total_tokens>14881209 tokens left</total_tokens>", value: "14881209", label: "account_number" },
    // 运行 id、哈希和版本
    { text: "| 6123456789 | ci.yml | success |", value: "6123456789", label: "account_number" },
    { text: "ba319a758 gateway: the lone tool_choice none", value: "ba319a758", label: "account_number" },
    { text: "Update to v0.1.1442 now", value: "0.1.1442", label: "account_number" },
    { text: "a screenshot of 1624x1487 pixels", value: "1624x1487", label: "private_phone" },
    // 设置里模型和工具链的名字
    { text: 'groqAPIModel = "llama3-70b-8192"', value: "llama3-70b-8192", label: "secret" },
    { text: 'claudeAPIModel = "claude-3-5-sonnet-20241022"', value: "claude-3-5-sonnet-20241022", label: "secret" },
    { text: "--model mixtral-8x7b-32768 --max-tokens 4096", value: "mixtral-8x7b-32768", label: "secret" },
    { text: 'channel = "nightly-2026-09-01"', value: "nightly-2026-09-01", label: "secret" },
    // 模型和助手自己的名字
    { text: "You are powered by the model named Opus 5.5.", value: "Opus", label: "private_person" },
    { text: "Claude publishes it as an Artifact.", value: "Claude", label: "private_person" },
    { text: "Another Claude session holds the port.", value: "Another Claude", label: "private_person" },
    // 路径里的用户名、skill 名
    { text: "read /Users/yetone/workspace/projects/magpie/AGENTS.md", value: "yetone", label: "private_person" },
    { text: "- artifact-design: Design guidance", value: "artifact-design", label: "private_person" },
    // 从更长的词里切出来的 id
    { text: '"tool_use_id":"toolu_01XyZabcDEF123456"', value: "XyZabcDEF123456", label: "secret" },
    { text: '"id":"srvtoolu_01AbCdEfGhIjKlMnOp"', value: "srvtoolu_01AbCdEfGhIjKlMnOp", label: "secret" },
    { text: "<task-id>a97c9bc67cc1f1e27</task-id>", value: ">a97c9bc67cc1f1e27", label: "secret" },
    { text: "hex40 ok? 1 2f1d0c9b8a7e6f5d4c3b2a1908f7e6d5c4b3a291", value: "2f1d0c9b8a7e6f5d4c3b2a1908f7e6d5c4b3a291", label: "secret" },
    { text: "919585d1700e515ac38da49e31bc60a527fc15c2 ok? 1", value: "919585d1700e515ac38da49e31bc60a527fc15c2 ok? 1", label: "secret" },
    // Go 模块缓存里的名字、路径的一截
    { text: "/Users/x/Library/Caches/go-build/63700b7ab65fd1d3@v63", value: "63700b7ab65fd1d3@v63", label: "secret" },
    { text: "d6426ecaaf0a28de@v31", value: "d6426ecaaf0a28de@v31", label: "private_email" },
    { text: "P=/Users/yetone/.npm/_npx/1e7f6d9597241db0", value: "/yetone/.", label: "private_email" },
    // base64 图片的一截
    { text: "iVBORw0KGgoAAAANSUhEUgAA+k5zM7Md7tM9ehxd51xF/isvM9", value: "k5zM7Md7tM9ehxd51xF", label: "secret" },
    // grep 的分支、会话文件、链接
    { text: "rg 'modelTakes|modelFits|personFits' internal", value: "modelTakes|modelFits|personFits", label: "secret" },
    { text: "wrote 31a4f944-e7cf-4f6f-acc7-eef50d9911dd.jsonl", value: "31a4f944-e7cf-4f6f-acc7-eef50d9911dd.jsonl", label: "secret" },
    { text: "join at discord.gg/Ab3dEf9h today", value: "discord.gg/Ab3dEf9h", label: "secret" },
    // Claude Code 会话（10-26，报告者的“95% 是错的”）：指标小数、运行 id、后台任务 id、模型名、文件名、
    // grep 的正则、带更多词的 id、转录路径、主机名、缩写和产品
    { text: "2026-10-21T08:20:00Z 104.21875033916251\n", value: "104.21875033916251", label: "private_phone" },
    { text: "2026-10-21T08:20:00Z 104.21875033916251\n", value: "104.21875033916251", label: "account_number" },
    { text: "see [run 48213097715](https://ci.example/runs/48213097715)", value: "run 48213097715", label: "private_phone" },
    { text: "env -u GH_TOKEN gh run view 48213097715 --log", value: "48213097715", label: "secret" },
    { text: "Command running in background with ID: kq3m8zx2t. Output is", value: "kq3m8zx2t", label: "secret" },
    { text: "moved to the background (ID: kq3m8zx2t).", value: "kq3m8zx2t", label: "secret" },
    { text: "<task-id>kq3m8zx2t</task-id>", value: "kq3m8zx2t", label: "secret" },
    { text: '{"backgroundTaskId":"kq3m8zx2t"}', value: "kq3m8zx2t", label: "secret" },
    { text: "'litellm_model_name': 'qwen/qwen3-30b-a3b-instruct-2507'}", value: "qwen/qwen3-30b-a3b-instruct-2507", label: "secret" },
    { text: "-rw-r--r--  1 x  staff  690 Aug 20 19:58 make-icons.sh", value: "make-icons.sh", label: "secret" },
    { text: "grep -n 'glm-5\\b\\|glm/glm-4' notes", value: "glm-5\\b\\|glm/glm-4", label: "secret" },
    { text: '"gatewayRequestId":"req_gateway_7c41e09a5bd2f368"', value: "req_gateway_7c41e09a5bd2f368", label: "secret" },
    { text: '{"ledgerId":"gl_Wq7rTb2xNe5YpLaZ"}', value: 'ledgerId":"gl_Wq7rTb2xNe5YpLaZ', label: "secret" },
    { text: "- tb_Ra4Kp9Lm-ZqT2wXy_8Hs: release about 17:05Z", value: "tb_Ra4Kp9Lm-ZqT2wXy_8Hs", label: "secret" },
    { text: "transcript at: /Users/x/.claude/projects/-Users-x-work/7e3f9a12-4c6b.jsonl", value: "Users-x-work/7e3f9a12-4c6b.jsonl", label: "private_address" },
    { text: '"edge":"eu.stg.acme.io","score":false', value: "eu.stg.acme.io", label: "private_email" },
    { text: "wait until CI is green", value: "CI", label: "private_person" },
    { text: "CodeRabbit\tpending\t0", value: "CodeRabbit", label: "private_person" },
    { text: "Greptile Review at https://app.greptile.com/r/1", value: "Greptile", label: "private_person" },
    // 被调用的方法：gctx.GetInt64 曾被遮成编造的密钥（#4444）
    { text: 'rows, err := gctx.GetInt64("user_id")', value: "gctx.GetInt64", label: "secret" },
    // 设置里的词，模型无论在哪儿都当名字：白名单，报告者三天 821 次替换（tianyk, #4087）
    { text: "开启白名单之后，把要放行的域名填进去。", value: "白名单", label: "private_person" },
  ];
  for (const c of cases) {
    test(`${c.label} ${JSON.stringify(c.value)} in ${JSON.stringify(c.text).slice(0, 50)}`, () => {
      expect(fakeFind(c.text, { [c.value]: c.label }).length).toBeGreaterThan(0); // 模型确实找到了它，不是空转
      expect(spansOf(c.text, { [c.value]: c.label })).toEqual([]);
    });
  }
});

describe("modelfits_test.go：TestModelFindsStillMasked", () => {
  const cases: Case[] = [
    { text: "my account is 13393848347348", value: "13393848347348", label: "account_number" },
    { text: "Ask Rina Kowalczyk about it", value: "Rina Kowalczyk", label: "private_person" },
    { text: "Ludwig van Beethoven wrote it", value: "Ludwig van Beethoven", label: "private_person" },
    { text: "call me on 13800138000 tonight", value: "13800138000", label: "private_phone" },
    { text: "ring 020 7946 0958 after six", value: "020 7946 0958", label: "private_phone" },
    { text: "send it to 42 Wallaby Way, Sydney", value: "42 Wallaby Way, Sydney", label: "private_address" },
    { text: "the vault phrase is Zq8vR2mT6wLp", value: "Zq8vR2mT6wLp", label: "secret" },
    // 没有尺寸或日期的小写连字符词是口令
    { text: "the wifi passphrase is correct-horse-battery-staple", value: "correct-horse-battery-staple", label: "secret" },
    { text: "password: maple-4-river-77", value: "maple-4-river-77", label: "secret" },
    { text: "api key: 9f2c4e1a7b3d5c8e9f2c4e1a7b3d5c8e", value: "9f2c4e1a7b3d5c8e9f2c4e1a7b3d5c8e", label: "secret" },
    { text: "write to rina.k@kowalczyk.pl", value: "rina.k@kowalczyk.pl", label: "private_email" },
    // 与上面放行的并排
    { text: "the stripe one is sk_test_AbCdEfGh_IjKlMn", value: "sk_test_AbCdEfGh_IjKlMn", label: "secret" },
    // 规则够不着的点分真密钥
    { text: "the vault phrase is alpha.bravo.charlie9", value: "alpha.bravo.charlie9", label: "secret" },
    // 后面跟括号和词的不是调用，逗号跟在冒号后面的也不是（#4444 的守卫）
    { text: "tell Bob it is Pw7nK4xQ9rTe (rotated today)", value: "Pw7nK4xQ9rTe", label: "secret" },
    { text: "tell Bob it is delta.echo.foxtrot7 (keep it)", value: "delta.echo.foxtrot7", label: "secret" },
    { text: "note: hunterTwoThree, keep it", value: "hunterTwoThree", label: "secret" },
    { text: "the token is 9f2c4e1a7b3d5c8e9f2c", value: "9f2c4e1a7b3d5c8e9f2c", label: "secret" },
    { text: "ask McDonald, he knows", value: "McDonald", label: "private_person" },
    { text: "write to Rina at rina.lee@kowalczyk.pl", value: "Rina", label: "private_person" },
    // 周围的话说是人的中文名
    { text: "找王芳确认一下档期", value: "王芳", label: "private_person" },
    { text: "ring +1 415.555.0132 after six", value: "+1 415.555.0132", label: "private_phone" },
    { text: "we live at 3/12 Smith Street, Sydney", value: "3/12 Smith Street, Sydney", label: "private_address" },
  ];
  for (const c of cases) {
    test(`${c.label} ${JSON.stringify(c.value)}`, () => {
      const out = masked(c.text, { [c.value]: c.label });
      expect(fakeFind(c.text, { [c.value]: c.label }).length).toBeGreaterThan(0);
      expect(out.includes(c.value)).toBe(false);
      expect(out).toContain("{{");
    });
  }
});

describe("modelids_test.go", () => {
  const meta =
    '{"installation_id":"6f1c2a0e-8b7d-4c3a-9e21-5d4b3c2a1f00","session_id":"019a0b1c-2d3e-7f40-8a1b-2c3d4e5f6a7b","agent_name":"/root","turn_id":"019a0b1c-9999-7f40-8a1b-2c3d4e5f6a7b","window_id":"019a0b1c-2d3e-7f40-8a1b-2c3d4e5f6a7b:0","window_number":0,"request_kind":"turn"}';
  const values: Record<string, string> = {
    "6f1c2a0e-8b7d-4c3a-9e21-5d4b3c2a1f00": "secret",
    "019a0b1c-2d3e-7f40-8a1b-2c3d4e5f6a7b": "secret",
    "019a0b1c-9999-7f40-8a1b-2c3d4e5f6a7b": "secret",
    "019a0b1c-2d3e-7f40-8a1b-2c3d4e5f6a7b:0": "secret",
    "4f2a9c1e-77b3-4d1a-b2e0-9c8d7e6f5a4b": "secret",
    "sha256 9b74c9897bac770ffc029102a200c5de2b6e0f3c7f1d0f2a7c3b5e1d9f8a7c6b": "secret",
    "/Users/vdxz/.codex/skills/wrangler/SKILL.md": "secret",
    "Tr0ub4dor&3xq": "secret",
    "9f8e7d6c5b4a39281706f5e4d3c2b1a0": "secret",
  };
  test("TestModelSecretIsNoID：Codex 一轮元数据里的 id 原样", () => {
    expect(spansOf(meta, values)).toEqual([]);
  });
  test("TestModelSecretIsNoID：请求 id、摘要、skill 路径原样，密码和密钥仍遮", () => {
    const text =
      "request id 4f2a9c1e-77b3-4d1a-b2e0-9c8d7e6f5a4b failed; sha256 9b74c9897bac770ffc029102a200c5de2b6e0f3c7f1d0f2a7c3b5e1d9f8a7c6b; - wrangler: Cloudflare Workers CLI (file: /Users/vdxz/.codex/skills/wrangler/SKILL.md). my password is Tr0ub4dor&3xq and the api key is 9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const sp = spansOf(text, values);
    expect(covered(text, sp)).toEqual(["Tr0ub4dor&3xq", "9f8e7d6c5b4a39281706f5e4d3c2b1a0"]);
  });
});

describe("program_words_test.go", () => {
  const cmd = "ls node_modules";
  const listing = "@types\ntypescript\nvite\n";
  const bin = "node_modules/.bin/tsc --noEmit";
  const sentence = "node_modules 太大了";
  for (const label of ["private_person", "private_address", "secret"]) {
    for (const v of ["node_modules", "node_modules/", "node_modules 太", "ls node_modules"]) {
      if (label === "secret" && v.includes(" ")) continue; // 带词的密钥区间：这里不改
      test(`TestModelLeavesProgramWords ${label} ${JSON.stringify(v)}`, () => {
        for (const t of [cmd, listing, bin, sentence]) expect(spansOf(t, { [v]: label })).toEqual([]);
      });
    }
  }
  const klass: [string, string][] = [
    ["du -sh site-packages __pycache__ dist vendor", "site-packages"],
    ["du -sh site-packages __pycache__ dist vendor", "__pycache__"],
    ["du -sh site-packages __pycache__ dist vendor", "dist"],
    ["du -sh site-packages __pycache__ dist vendor", "vendor"],
    ["find . -name __pycache__ -prune", "__pycache__"],
    ["rm -rf node_modules && pnpm install", "node_modules"],
    ["确实有问题。node_modules给识别成姓名了", "node_modules给"],
  ];
  for (const [text, value] of klass) {
    for (const label of ["private_person", "private_address", "secret"]) {
      if (label === "secret" && value.includes("给")) continue;
      test(`类：${label} ${JSON.stringify(value)}`, () => {
        expect(spansOf(text, { [value]: label })).toEqual([]);
      });
    }
  }
  test("TestModelStillMasksNamesBesideProgramWords：真名字和真地址仍遮", () => {
    const text = "Rina Kowalczyk said node_modules is 2 GB; she lives at 42 Wallaby Way, Sydney, 张伟住在建国路88号";
    const sp = spansOf(text, {
      "Rina Kowalczyk": "private_person",
      "42 Wallaby Way, Sydney": "private_address",
      建国路88号: "private_address",
      node_modules: "private_person",
    });
    expect(covered(text, sp)).toEqual(["Rina Kowalczyk", "42 Wallaby Way, Sydney", "建国路88号"]);
  });
});

describe("vendorchecks_test.go", () => {
  test("TestMaskJSONKeepsReasoningSummaryDelivery：snake_case 词原样，旁边的名字仍遮", () => {
    const text = "set sequential_cutoff for Rina Kowalczyk";
    const sp = spansOf(text, { sequential_cutoff: "private_person", "Rina Kowalczyk": "private_person" });
    expect(covered(text, sp)).toEqual(["Rina Kowalczyk"]);
  });
  test("TestModelTakesNoSnakeWord", () => {
    for (const v of ["sequential_cutoff", "list_threads", "mcp__codex_app", "in_progress", "HTTP_PROXY"]) {
      expect(modelTakes("PERSON", v)).toBe(false);
      expect(snakeWord(v)).toBe(true);
    }
    for (const v of ["Rina Kowalczyk", "O'Brien", "张伟", "Jean-Luc"]) expect(modelTakes("PERSON", v)).toBe(true);
  });
  test("TestModelPhoneKeepsUnixTime：Unix 时间原样，电话仍遮", () => {
    const text = '{"event": "tool_call", "timestamp": 1792903687, "ms": 1792903687123, "at": "2026-10-25T04:48:03.755Z", "desk": "+1 415 555 0132"}';
    const sp = spansOf(text, { "1792903687": "private_phone", "1792903687123": "private_phone", "+1 415 555 0132": "private_phone" });
    expect(covered(text, sp)).toEqual(["+1 415 555 0132"]);
    for (const v of ["13800138000", "2125551234", "1792903687x", "179290368", "+11792903687"]) expect(epochNumber(v)).toBe(false);
    for (const v of ["1792903687", "1792903687123"]) expect(epochNumber(v)).toBe(true);
  });
});

describe("hexliteral_test.go", () => {
  const cases: [string, string][] = [
    ["| `sub_4EA5E0` | `0x004EA5E0` | 解密函数入口 |", "0x004EA5E0"],
    ["DecryptKey: 0x004EA5E0", "0x004EA5E0"],
    ["the token is 0X7FFE0300", "0X7FFE0300"],
    ["mask = 0xFFFFFFFFFFFFFFFF;", "0xFFFFFFFFFFFFFFFF"],
    ["base 0x00007ff6a1b20000 in x64dbg", "0x00007ff6a1b20000"],
  ];
  for (const [text, value] of cases) {
    for (const label of ["secret", "account_number", "private_phone"]) {
      test(`十六进制数原样 ${label} ${value}`, () => {
        expect(spansOf(text, { [value]: label })).toEqual([]);
      });
    }
  }
  const pk = "0x9b2e1f4c7a3d5e8f0b6c2a4d9e1f3b5c7d0a2e4f6b8c1d3e5f7a9b0c2d4e6f81";
  const k128 = "0x5e8f0b6c2a4d9e1f3b5c7d0a2e4f6b8c";
  for (const [text, value] of [
    [`私钥 ${pk} 别外传`, pk],
    [`deploy with ${pk}`, pk],
    [`seed ${k128}`, k128],
  ] as [string, string][]) {
    test(`十六进制写的密钥仍遮：${value.slice(0, 12)}…`, () => {
      expectMasked(text, { [value]: "secret" }, value);
    });
  }
});

describe("symbol_test.go", () => {
  const symbolLines = [
    "  401126:\te8 05 ff ff ff       \tcall   401030 <system@plt>",
    "0000000000401030 <system@plt>:",
    "  401030:\tff 25 e2 2f 00 00    \tjmp    *0x2fe2(%rip)        # 404018 <system@GLIBC_2.2.5>",
    "  4011a2:\tff 15 48 2e 00 00    \tcall   *0x2e48(%rip)        # 403ff0 <puts@got.plt>",
    "  401156:\te8 e5 fe ff ff       \tcall   401040 <_ZNSt8ios_base4InitC1Ev@plt>",
    "   7: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND printf@GLIBC_2.2.5 (2)",
    "0000000000000000       F *UND*\t0000000000000000              memcpy@GLIBC_2.14",
    "0000000000001139 g     F .text\t000000000000001e              foo@@GLIBC_2.2.5",
    "                 U __libc_start_main@GLIBC_2.34",
    " foo@Base 1.0",
    "   0x0000555555555171 <+8>:\tcall   0x555555555030 <printf@plt>",
    "\tcall\tprintf@PLT",
    "call    _system",
    ".plt.sec:0000000000001060 jmp     cs:off_3FD0 ; system@got",
    "extrn system@@GLIBC_2_2_5:near",
    "  401040:\tff 25 d2 2f 00 00    \tjmp    *0x2fd2(%rip)        # 404018 <memcpy@plt.sec>",
    "  401050:\tff 25 ca 2f 00 00    \tjmp    *0x2fca(%rip)        # 403fe0 <free@plt.got>",
  ];
  const symbols = [
    "system@plt", "system@GLIBC_2.2.5", "puts@got.plt", "_ZNSt8ios_base4InitC1Ev@plt", "printf@GLIBC_2.2.5", "memcpy@GLIBC_2.14",
    "foo@@GLIBC_2.2.5", "__libc_start_main@GLIBC_2.34", "foo@Base", "printf@plt", "printf@PLT", "system@got", "free@plt.got",
    "system@@GLIBC_2_2_5", "memcpy@plt.sec",
  ];
  const values = Object.fromEntries(symbols.map((v) => [v, "private_email"]));
  symbolLines.forEach((line, i) => {
    test(`TestSymbolIsNoEmail：模型的 EMAIL 不取符号 #${i}`, () => {
      expect(spansOf(line, values)).toEqual([]);
    });
  });
  for (const s of [
    "call 401030 <system@plt> then mail rina.k@fastmail.com",
    '\tconst owner = "rina.k@fastmail.com" // see <puts@got.plt>',
    "objdump -d ./a.out | grep system@plt, and send it to ops@build01.acme.io",
  ]) {
    test(`真地址仍遮：${s.slice(0, 40)}`, () => {
      const sp = spansOf(s, { "rina.k@fastmail.com": "private_email", "ops@build01.acme.io": "private_email", "system@plt": "private_email", "puts@got.plt": "private_email" });
      expect(sp).toHaveLength(1);
      expect(["rina.k@fastmail.com", "ops@build01.acme.io"]).toContain(covered(s, sp)[0]!);
    });
  }
});

describe("filename_test.go / email_tld_test.go / git_remote_test.go / userinfo_test.go：EMAIL 的模型部分", () => {
  test("TestFileNameIsNoEmail：模型的 EMAIL 不取文件名", () => {
    const t = "/Users/vdxz/Pictures/261020_14-16-11@2x.jpg";
    expect(spansOf(t, { "261020_14-16-11@2x.jpg": "private_email" })).toEqual([]);
  });
  for (const [input, file, email] of [
    ["attach /Users/me/Invoices/alice.smith@acme.com.pdf", "alice.smith@acme.com.pdf", "alice.smith@acme.com"],
    ["open export-rina.k@fastmail.com.png", "export-rina.k@fastmail.com.png", "rina.k@fastmail.com"],
    ["see john@gmail.com.jpg", "john@gmail.com.jpg", "john@gmail.com"],
    ["unpack ops@corp.co.uk.tar.gz now", "ops@corp.co.uk.tar.gz", "ops@corp.co.uk"],
    ['{"path":"scans/jane@studio.io.heic"}', "jane@studio.io.heic", "jane@studio.io"],
  ] as const) {
    test(`TestEmailInAFileNameIsMasked ${file}`, () => {
      const sp = spansOf(input, { [file]: "private_email" });
      expect(sp).toHaveLength(1);
      expect(covered(input, sp)[0]!.includes(email)).toBe(true);
    });
  }
  for (const s of ["logo@2x.jpg", "icon@3x.png", "banner@final.pdf", "strings@base.json", "icon@2x.zip", "intro@1.5x.mov.mp4"]) {
    test(`TestEmailInAFileNameIsMasked：${s} 是文件名`, () => {
      expect(spansOf(`see ${s} here`, { [s]: "private_email" })).toEqual([]);
    });
  }
  for (const s of ["xxx@Agents.md", "x@pytest.fixture", "follow docs@AGENTS.md", "cls@dataclasses.dataclass", "def@pytest.mark.parametrize"]) {
    test(`TestEmailNeedsAMailDomain：模型的 ${s} 不是地址`, () => {
      expect(spansOf(`look at ${s} now`, { [s]: "private_email" })).toEqual([]);
    });
  }
  for (const s of ["rina.k@fastmail.com", "dev@startup.io", "me@notes.md", "ops@corp.example.co.uk", "x@company.ai", "li.wei@qq.com", "admin@build.local", "ops@mail.corp", "j@Gmail.COM"]) {
    test(`TestEmailNeedsAMailDomain：真地址 ${s} 仍遮`, () => {
      const t = `mail ${s} today`;
      // ops@corp.example.co.uk 的 host 以 .uk 结尾但含 example 之外的标签：magpie 的 fake 列表只拒绝 host 以 example.* 结尾
      expect(covered(t, spansOf(t, { [s]: "private_email" }))).toEqual([s]);
    });
  }
  for (const s of ["git@github.com", "git@gitlab.com", "GIT@GitHub.com"]) {
    test(`TestGitRemoteIsNoEmail：${s}`, () => {
      expect(spansOf(`${s}:o/r.git`, { [s]: "private_email" })).toEqual([]);
    });
  }
  for (const s of ["gitte@fastmail.com", "git.lee@acme-corp.com", "github@acme-corp.com"]) {
    test(`TestGitRemoteIsNoEmail：${s} 仍是地址`, () => {
      const t = `mail ${s} today`;
      expect(covered(t, spansOf(t, { [s]: "private_email" }))).toEqual([s]);
    });
  }
  test("TestURLUserinfoIsNoEmail：模型的 EMAIL 不取 URL 里的密码加主机", () => {
    const t = "postgres://app:hunter2pass@db.acme-corp.cn:5432/x";
    expect(spansOf(t, { "hunter2pass@db.acme-corp.cn": "private_email" })).toEqual([]);
  });
  test("TestURLUserinfoIsNoEmail：路径和查询里的地址仍遮", () => {
    for (const t of ["https://lists.acme-corp.cn/archive/rina.k@fastmail.com", "https://acme-corp.cn/invite?to=rina.k@fastmail.com", "mail rina.k@fastmail.com today"]) {
      expect(covered(t, spansOf(t, { "rina.k@fastmail.com": "private_email" }))).toEqual(["rina.k@fastmail.com"]);
    }
  });
});

describe("decimal_test.go / token_count_test.go", () => {
  const frac = "13393848347348";
  test("TestDecimalDigitsNotMaskedByModel：小数里的数字", () => {
    expect(spansOf(`{"height": 5.${frac}}`, { [frac]: "account_number" })).toEqual([]);
    const t = `my account is ${frac}`;
    expect(covered(t, spansOf(t, { [frac]: "account_number" }))).toEqual([frac]);
  });
  test("noNumbers：小数里的手机号（即使有线索）与裸 JSON 数字原样", () => {
    for (const t of ["phone 0.13800138000 ok", "phone 13800138000.25 ok", "phone x=-7.13800138000e2", '{"phone": 13800138000}', '{"phone":[13800138000, 13900139000]}']) {
      const m = /1[34]\d{9}/.exec(t)![0];
      expect(spansOf(t, { [m]: "private_phone" })).toEqual([]);
    }
    for (const t of ['{"phone": "13800138000"}', "phone:13800138000", "call 13800138000, thanks", 'call ["13800138000"], thanks']) {
      expect(covered(t, spansOf(t, { "13800138000": "private_phone" }))).toEqual(["13800138000"]);
    }
  });
  for (const n of ["1499872", "1493809", "14998720", "14938090"]) {
    test(`TestTokenCountIsNoSecret ${n}`, () => {
      const reminder = `<system-reminder>\n<total_tokens>${n} tokens left</total_tokens>\n</system-reminder>`;
      expect(spansOf(reminder, { [n]: "secret" })).toEqual([]);
    });
  }
  for (const [text, v] of [
    ['{"usage":{"total_tokens": 14998721}}', "14998721"],
    ["max_tokens: 32000000", "32000000"],
    ["token_count=14998722", "14998722"],
    ["spin: 14998723", "14998723"],
  ] as const) {
    test(`TestTokenCountIsNoSecret：${text}`, () => {
      expect(spansOf(text, { [v]: "secret" })).toEqual([]);
    });
  }
  for (const [text, v] of [
    ["api_key=48213097715", "48213097715"],
    ['{"token": "73914682055"}', "73914682055"],
    ["the access token is 73914682055", "73914682055"],
    ["PIN: 73914682", "73914682"],
    ["user_pin=73914682", "73914682"],
    ["wifi password: 83920175", "83920175"],
    ["密码是83920175", "83920175"],
    ["<token>73914682055</token>", "73914682055"],
  ] as const) {
    test(`TestNamedNumberSecretStillMasked：${text}`, () => {
      expect(covered(text, spansOf(text, { [v]: "secret" }))).toEqual([v]);
    });
  }
});

describe("standin_ip_test.go：TestEVMAddressGoesAsWritten", () => {
  const addr = "0x89dfBD9b4C2e7A1f3D5b6E8c0A9F2d4B7e1C3a5D";
  const pk = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
  for (const text of [`挖矿收益打到这个合约地址 ${addr} 就行，不需要签名`, `wallet: ${addr}`, `{"to":"${addr}","value":"0x0"}`, `address is ${addr}.`]) {
    for (const label of ["secret", "account_number"]) {
      test(`钱包地址原样 ${label} ${text.slice(0, 24)}`, () => {
        expect(spansOf(text, { [addr]: label })).toEqual([]);
      });
    }
  }
  for (const [text, value] of [
    [`私钥 ${pk} 别外传`, pk],
    [`the key is ${pk}`, pk],
    [`api key: ${addr}`, addr],
    [`token is ${addr}`, addr],
  ] as const) {
    test(`叫做密钥的仍遮：${text.slice(0, 24)}`, () => {
      expectMasked(text, { [value]: "secret" }, value);
    });
  }
});

describe("ids_test.go：模型部分（id 与元素令牌）", () => {
  const ids = [
    "3f2b8c1e-9a4d-4e7b-b2c1-7d6e5f4a3b21",
    "3F2B8C1E-9A4D-4E7B-B2C1-7D6E5F4A3B21",
    "3f2b8c1e-9a4d-4e7b-b2c1-a13800138000",
    "abcd4111-1111-1111-9007-abcdef123456",
    "3f2b8c1e9a4d4e7bb2c1a13800138000",
    "9f8e7d6cabcd4111111111111111900713800138000a",
    "12345678-1234-1234-1234-123456789012",
  ];
  const labels = ["private_person", "private_address", "private_phone", "private_email", "account_number", "secret"];
  for (const label of labels) {
    test(`TestIDsGoAsWritten：模型把 id 标成 ${label} 也原样`, () => {
      for (const id of ids) {
        const t = `look at order ${id} please`;
        expect(spansOf(t, { [id]: label })).toEqual([]);
      }
    });
  }
  for (const label of labels) {
    test(`TestElementTokensGoAsWritten：元素令牌标成 ${label} 也原样`, () => {
      expect(spansOf("click s0000002a:14 again", { "s0000002a:14": label })).toEqual([]);
      expect(spansOf('{\\"element_index\\": 0, \\"element_token\\": \\"s00000001\\"}', { s00000001: label })).toEqual([]);
    });
  }
  for (const label of ["account_number", "secret"]) {
    for (const text of ["my student number is s12345678", '"student_no": "s12345678"']) {
      test(`没有下标、不在元素字段里的 s+8 位数字仍遮 ${label} ${text}`, () => {
        expect(covered(text, spansOf(text, { s12345678: label }))).toEqual(["s12345678"]);
      });
    }
  }
  test("id 里的手机号形状是 id 的一截", () => {
    const id = "3f2b8c1e-9a4d-4e7b-b2c1-a13800138000";
    expect(spansOf(`order ${id}`, { "13800138000": "private_phone" })).toEqual([]);
  });
  test("32 位十六进制：散文里的密钥仍遮，以哈希为键的字段名不遮，cacheKey 的值不遮", () => {
    const k = "5d41402abc4b2a78";
    expect(covered(`the api key is ${k}`, spansOf(`the api key is ${k}`, { [k]: "secret" }))).toEqual([k]);
    expect(spansOf(`{"keys": {"${k}": 1}}`, { [k]: "secret" })).toEqual([]);
    expect(spansOf(`{"cacheKey": "${k}"}`, { [k]: "secret" })).toEqual([]);
    expect(spansOf(`{"key": "${k}"}`, { [k]: "secret" })).toEqual([]);
    expect(covered(`{"access_token": "${k}"}`, spansOf(`{"access_token": "${k}"}`, { [k]: "secret" }))).toEqual([k]);
  });
});

describe("package_*_test.go：模型部分", () => {
  const notMasked: [string, string][] = [
    ["{\n  \"dependencies\": {\n    \"drizzle-orm\": \"^0.36.4\",\n    \"jsonwebtoken\": \"~9.0.2\"\n  }\n}", "drizzle-orm"],
    ['{"devDependencies": {"drizzle-kit": "0.28.1"}}', "drizzle-kit"],
    ['"jsonwebtoken": "workspace:*",', "jsonwebtoken"],
    ['"drizzle-orm": ">=0.30.0 <1",', "drizzle-orm"],
    ['[dependencies]\njsonwebtoken = "9"\n', "jsonwebtoken"],
    ["     1→import drizzle from 'drizzle-orm';", "drizzle-orm"],
    ["     2\timport sql from 'postgres';\n", "postgres"],
    ["     3→import { pgTable } from 'drizzle-orm/pg-core';", "drizzle-orm"],
    ["import { z } from '@acme/drizzle-orm';", "drizzle-orm"],
    ['12: import { sql } from "drizzle-orm";', "drizzle-orm"],
    ["+import { and, eq } from ' drizzle-orm '", "drizzle-orm"],
    ["-const jwt = require('jsonwebtoken')", "jsonwebtoken"],
    ["node_modules/drizzle-orm/pg-core/columns/text.d.ts:12:5 - error TS2322", "drizzle-orm"],
    ["src/db.ts:1:27 - error TS2307: Cannot find module 'drizzle-orm' or its corresponding type declarations.", "drizzle-orm"],
    ["Error: Cannot find module 'jsonwebtoken'\nRequire stack:", "jsonwebtoken"],
    ["ModuleNotFoundError: No module named 'secretstorage'", "secretstorage"],
    ["pnpm add drizzle-orm postgres && pnpm add -D drizzle-kit", "drizzle-orm"],
    ["npm install --save jsonwebtoken", "jsonwebtoken"],
    ["pip install django-rest-passwordreset", "django-rest-passwordreset"],
    ["cargo add jsonwebtoken", "jsonwebtoken"],
    ["added drizzle-orm@0.36.4 to dependencies", "drizzle-orm"],
    ["  drizzle-orm@0.36.4:\n    resolution: {}", "drizzle-orm"],
    // TestModelPackageNamesNotMasked
    ["import { and, eq } from ' drizzle-orm '", "drizzle-orm"],
    ["import { and, eq } from 'drizzle-orm';", "drizzle-orm"],
    ['} from "drizzle-orm/pg-core";', "drizzle-orm/pg-core"],
    ["export * from '@acme/secret-store';", "@acme/secret-store"],
    ["import 'reflect-metadata'", "reflect-metadata"],
    ["const jwt = require( ' jsonwebtoken ' );", "jsonwebtoken"],
    ["const m = await import('node:crypto')", "node:crypto"],
    ["from secretstorage import collection", "secretstorage"],
    ["import jsonwebtoken as jwt", "jsonwebtoken"],
    ["use jsonwebtoken::{encode, Header};", "jsonwebtoken"],
    ["django-rest-passwordreset==1.4.0\n", "django-rest-passwordreset"],
    ["tokenizers>=0.15\n", "tokenizers"],
    [
      "resolution: {integrity: sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}",
      "sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}",
    ],
  ];
  notMasked.forEach(([text, value], i) => {
    test(`包名/模块名不是密钥 #${i} ${value.slice(0, 24)}`, () => {
      expect(fakeFind(text, { [value]: "secret" }).length).toBeGreaterThan(0);
      expect(spansOf(text, { [value]: "secret" })).toEqual([]);
    });
  });
  const stillMasked: [string, string][] = [
    ['{"password": "Zq8vR2mT6wLp"}', "Zq8vR2mT6wLp"],
    ['{"Zq8vR2mT6wLp": "hunter2"}', "Zq8vR2mT6wLp"],
    ["the login is Zq8vR2mT6wLp@10.0.0.5", "Zq8vR2mT6wLp"],
    ["     1→const token = 'Zq8vR2mT6wLp';", "Zq8vR2mT6wLp"],
    ["use the code Zq8vR2mT6wLp to install it", "Zq8vR2mT6wLp"],
    // TestPackageNameChecksKeepRealValues 的模型部分
    ["I copied the token from 'Zq8vR2mT6wLp' yesterday", "Zq8vR2mT6wLp"],
    ["copy it from Zq8vR2mT6wLp now", "Zq8vR2mT6wLp"],
    ["the vault phrase is Zq8vR2mT6wLp", "Zq8vR2mT6wLp"],
    ["mysql -p s3cretPass@10.0.0.5", "s3cretPass"],
    ["pw Zq8vR2mT6wLp==", "Zq8vR2mT6wLp"],
    ["secret_version = 'Zq8vR2mT6wLp'", "Zq8vR2mT6wLp"],
    ["password=hunter2pass9", "hunter2pass9"],
    ["API_KEY=AbC123dEf456GhI789", "AbC123dEf456GhI789"],
  ];
  stillMasked.forEach(([text, value], i) => {
    test(`旁边的真值仍遮 #${i} ${text.slice(0, 30)}`, () => {
      expectMasked(text, { [value]: "secret" }, value);
    });
  });
});

describe("package_words_test.go：TestModelWordsArentSecrets / TestWordSecretsStillMasked", () => {
  const dnirayBlock =
    "```ts\nexport default defineConfig({\n  entry: ['src/main.ts'],\n  format: [\n  'cjs',\n  clean: true,\n  noExternal: [/@nexus\\/shared/],\n  external: [/@nestjs/, 'reflect-metadata', 'rxjs', 'mysql2', 'drizzle-orm'],\n  sourcemap: true,\n})\n```\n";
  const v = { "drizzle-orm": "secret", "reflect-metadata": "secret" };
  test("tsup 配置围栏、散文里小写词组成的“密钥”原样", () => {
    expect(spansOf(`tsup.config.ts:\n\n${dnirayBlock}\nwhy is drizzle-orm bundled?`, v, {}, 0.93)).toEqual([]);
    const read = dnirayBlock
      .trimEnd()
      .split("\n")
      .map((l, i) => `     ${String.fromCharCode(49 + (i % 9))}→${l}\n`)
      .join("");
    expect(spansOf(read, v, {}, 0.93)).toEqual([]);
    for (const s of ["we keep drizzle-orm external", "drizzle-orm", "see reflect-metadata."]) expect(spansOf(s, v, {}, 0.93)).toEqual([]);
  });
  for (const [text, value] of [
    ["PASSWORD=opensesame", "opensesame"],
    ['{"password": "letmeinplease"}', "letmeinplease"],
    ["the wifi password is purplemonkey", "purplemonkey"],
    ["api_key: correct-horse-battery", "correct-horse-battery"],
    ["login with hunter2pass", "hunter2pass"],
    ["use Zq8vR2mT6wLp to sign in", "Zq8vR2mT6wLp"],
    ["the code is Tr0ub4dor&3xq", "Tr0ub4dor&3xq"],
  ] as const) {
    test(`TestWordSecretsStillMasked：${text}`, () => {
      expectMasked(text, { [value]: "secret" }, value);
    });
  }
});

describe("thingname_test.go", () => {
  const apps = ["Cicada", "Mimi", "Phosphor", "Parakeet", "Muesli"];
  const appValues = Object.fromEntries(apps.map((a) => [a, "private_person"]));
  const appTexts = [
    "Cicada, Mimi, Phosphor, Parakeet, Muesli",
    "Cicada and Mimi",
    "1. **Cicada** – a minimal note-taking app with Markdown.\n2. **Mimi** – a voice memo app with AI summaries.\n3. **Phosphor** – an RSS reader.\n4. **Parakeet** – a podcast player for macOS.\n5. **Muesli** – a meal planner.",
    "I switched to Muesli last week; Parakeet crashes too often.",
    "I'm using Phosphor now, and Cicada vs Mimi is still open.",
    "Apps like Muesli are hard to find.",
    "Parakeet 这个软件很好用。",
  ];
  appTexts.forEach((s, i) => {
    test(`TestAppNamesNotPersons #${i}`, () => {
      expect(spansOf(s, appValues)).toEqual([]);
    });
  });
  const personValues = {
    Mimi: "private_person", Phosphor: "private_person", "John Smith": "private_person", Cicada: "private_person",
    Daniel: "private_person", Laura: "private_person", 张伟: "private_person", Parakeet: "private_person",
  };
  const beside: [string, string[], string[]][] = [
    ["My colleague Mimi said the Phosphor app is great; she uses it every day.", ["Mimi"], ["Phosphor"]],
    ["John Smith asked me to install Cicada on his Mac.", ["John Smith"], ["Cicada"]],
    ["张伟说 Parakeet 这个软件很好用，让我也装一个。", ["张伟"], ["Parakeet"]],
    ["Hi Mimi, thanks for the notes from Tuesday's call. Can you send them to Laura as well?", ["Mimi", "Laura"], []],
    ["Mimi will review the draft tomorrow and send it to Daniel.", ["Mimi", "Daniel"], []],
    ["Mimi", ["Mimi"], []], // 单独成文说明不了是谁的，可能是任何人
  ];
  for (const [s, mask_, keep] of beside) {
    test(`TestPersonBesideAppStillMasked ${s.slice(0, 30)}`, () => {
      const got = covered(s, spansOf(s, personValues));
      for (const m of mask_) expect(got).toContain(m);
      for (const k of keep) expect(got).not.toContain(k);
    });
  }
  test("TestFirstNameNearAThingMasked：名字单独、所有格、句中有系统词、旁边没有应用词，仍遮", () => {
    for (const s of ["Rina", "Rina's Mac won't boot", "Rina’s iPhone is on iOS 26", "Rina uses Windows at home", "Send the license to Rina."]) {
      expect(covered(s, spansOf(s, { Rina: "private_person" }))).toEqual(["Rina"]);
    }
  });
  test("TestFirstNameNearAThingMasked：工具调用参数里（args）一律遮", () => {
    // 原用例是 tool_use 的 input 与 function_call 的 arguments；JSON 遍历归 payload，这里验证 args 开关本身
    for (const s of ["Rina", '{"recipient":"Rina"}', "install Rina", "using Rina"]) {
      expect(covered(s, spansOf(s, { Rina: "private_person" }, { args: true }))).toEqual(["Rina"]);
    }
  });
  test("TestFirstNameNearAThingMasked：应用词紧挨着的仍是物", () => {
    for (const s of ["I'm using Rina now.", "the Rina app crashed"]) expect(spansOf(s, { Rina: "private_person" })).toEqual([]);
  });
});

describe("modelTakes / madeID / namesThing 单元", () => {
  test("madeID：厂商 id 的形状，Stripe 类密钥不是", () => {
    for (const v of ["req_011CSzQ8mXv3kBR2", "toolu_01AbCdEfGhIjKl", "call_x9AbCdEfGh", "req_gateway_7c41e09a5bd2f368", "tb_Ra4Kp9-ZqT2_8Hs1"]) expect(madeID(v)).toBe(true);
    for (const v of ["sk_live_AbCdEfGh_IjKlMn", "whsec_AbCdEf_GhIjKl", "plain", "a_b"]) expect(madeID(v)).toBe(false);
  });
  test("namesThing：UUID、摘要、路径、模型名", () => {
    for (const v of ["3f2b8c1e-9a4d-4e7b-b2c1-7d6e5f4a3b21", "3f2b8c1e-9a4d-4e7b-b2c1-7d6e5f4a3b21:0", "~/.ssh/config", "C:\\Users\\x", "qwen/qwen3-14b", "make-icons.sh"]) {
      expect(namesThing(v)).toBe(true);
    }
    expect(namesThing("Tr0ub4dor&3xq")).toBe(false);
  });
  test("modelTakes：密钥长度按 UTF-8 字节，账号不取 id，邮箱要 realEmail", () => {
    expect(modelTakes("SECRET", "密码1")).toBe(false); // 3+3+1 = 7 字节
    expect(modelTakes("SECRET", "密码12")).toBe(true); // 8 字节
    expect(modelTakes("SECRET", "hunter2")).toBe(false);
    expect(modelTakes("ACCOUNT", "toolu_01AbCdEfGhIjKl")).toBe(false);
    expect(modelTakes("EMAIL", "a@example.com")).toBe(false);
    expect(modelTakes("EMAIL", "noreply@acme.io")).toBe(false);
    expect(modelTakes("EMAIL", "rina@acme.io")).toBe(true);
    expect(modelTakes("PERSON", "J")).toBe(false);
    expect(modelTakes("SECRET", "0x004EA5E0")).toBe(false);
    expect(modelTakes("ADDRESS", "x")).toBe(true);
  });
});

describe("阈值、类别、allow、排序与重叠", () => {
  const text = "Ask Rina Kowalczyk at rina.k@kowalczyk.pl or Tomasz Brzezinski";
  const values = { "Rina Kowalczyk": "private_person", "rina.k@kowalczyk.pl": "private_email", "Tomasz Brzezinski": "private_person" };
  test("低于阈值的丢弃", () => {
    const finds = [
      { start: 4, end: 18, label: "private_person", score: 0.79 },
      { start: 22, end: 41, label: "email", score: 0.8 },
    ];
    expect(covered(text, modelSpans(text, finds, opts({ threshold: 0.8 })))).toEqual(["rina.k@kowalczyk.pl"]);
  });
  test("allow：整值不遮（去首尾空白、不分大小写），别的照遮", () => {
    const sp = spansOf(text, values, { allow: new Set([" rina kowalczyk "]) });
    expect(covered(text, sp)).toEqual(["rina.k@kowalczyk.pl", "Tomasz Brzezinski"]);
    // 只有整值相等才放行：值的一部分不放行
    expect(covered(text, spansOf(text, values, { allow: new Set(["Rina"]) })).length).toBe(3);
  });
  test("按起点排序、同起点取长、不重叠", () => {
    const finds = [
      { start: 22, end: 41, label: "email", score: 1 },
      { start: 4, end: 18, label: "private_person", score: 1 },
      { start: 4, end: 10, label: "private_person", score: 1 },
      { start: 12, end: 30, label: "private_person", score: 1 },
    ];
    const sp = modelSpans(text, finds, opts());
    for (let i = 1; i < sp.length; i++) expect(sp[i]!.start).toBeGreaterThanOrEqual(sp[i - 1]!.end);
    expect(sp[0]).toEqual({ start: 4, end: 18, kind: "PERSON" });
  });
  test("不在 kinds 里的类别不遮", () => {
    expect(covered(text, spansOf(text, values, { kinds: new Set<Kind>(["EMAIL"]) }))).toEqual(["rina.k@kowalczyk.pl"]);
    expect(ALL_KINDS.size).toBe(6);
  });
  test("标签：payment_card→ACCOUNT，url/ip_address/private_date 丢弃，未知标签丢弃", () => {
    const t = "card number 4111 1111 1111 1111 at 10.0.0.1 on 2026-10-18 https://acme.io/x";
    const finds = [
      { start: 12, end: 31, label: "payment_card", score: 1 },
      { start: 35, end: 43, label: "ip_address", score: 1 },
      { start: 47, end: 57, label: "private_date", score: 1 },
      { start: 58, end: 75, label: "url", score: 1 },
      { start: 0, end: 4, label: "nonsense", score: 1 },
    ];
    expect(modelSpans(t, finds, opts())).toEqual([{ start: 12, end: 31, kind: "ACCOUNT" }]);
    expect(fakeFind(t, {}).length).toBe(0);
  });
});
