import { describe, expect, test } from "bun:test";
import { detectFormat, formatForApi, maskPayload, type TextItem, type TextMasker } from "../src/payload.ts";

/** 把 “张伟” 换成 “<P>”，并记录看到的每个叶子（含 args 标记）。 */
function recorder(): { masker: TextMasker; seen: TextItem[] } {
  const seen: TextItem[] = [];
  return {
    seen,
    masker: {
      maskTexts: async (items) => {
        seen.push(...items);
        return items.map((i) => i.text.replaceAll("张伟", "<P>"));
      },
    },
  };
}

const sig = "SIGNATURE张伟";
const enc = "ENCRYPTED张伟";

describe("anthropic-messages", () => {
  const mk = () => ({
    model: "claude-张伟",
    max_tokens: 100,
    system: [{ type: "text", text: "system 张伟", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "张伟", description: "tool 张伟", input_schema: { type: "object", properties: { x: { type: "string", description: "张伟" } } } }],
    metadata: { user_id: "张伟" },
    messages: [
      { role: "user", content: "hi 张伟" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "思考 张伟", signature: sig },
          { type: "redacted_thinking", data: enc },
          { type: "text", text: "回复 张伟" },
          { type: "tool_use", id: "toolu_张伟", name: "write", input: { path: "/a/张伟.txt", content: "张伟 在这里", n: 3, nested: [{ k: "张伟" }] } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_张伟", content: [{ type: "text", text: "结果 张伟" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "张伟" } }] },
          { type: "tool_result", tool_use_id: "x", content: "字符串结果 张伟" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "张伟" } },
          { type: "compaction", content: "压缩 张伟", encrypted_content: enc },
        ],
      },
    ],
  });

  test("只改文本叶子，其余原样", async () => {
    const body = mk();
    const { masker, seen } = recorder();
    const n = await maskPayload("anthropic-messages", body, masker);
    expect(n).toBe(8);
    const ref = mk();
    expect(body.model).toBe(ref.model);
    expect(body.tools).toEqual(ref.tools);
    expect(body.metadata).toEqual(ref.metadata);
    expect(body.system[0]).toEqual({ type: "text", text: "system <P>", cache_control: { type: "ephemeral" } });
    expect(body.messages[0]!.content).toBe("hi <P>");
    const a = body.messages[1]!.content as any[];
    expect(a[0]).toEqual(ref.messages[1]!.content[0]); // thinking 原样
    expect(a[1]).toEqual(ref.messages[1]!.content[1]); // redacted_thinking 原样
    expect(a[2].text).toBe("回复 <P>");
    expect(a[3]).toEqual({ type: "tool_use", id: "toolu_张伟", name: "write", input: { path: "/a/<P>.txt", content: "<P> 在这里", n: 3, nested: [{ k: "<P>" }] } });
    const u = body.messages[2]!.content as any[];
    expect(u[0].content[0].text).toBe("结果 <P>");
    expect(u[0].content[1]).toEqual((ref.messages[2]!.content as any[])[0].content[1]); // 图片
    expect(u[1].content).toBe("字符串结果 <P>");
    expect(u[2]).toEqual((ref.messages[2]!.content as any[])[2]);
    expect(u[3]).toEqual((ref.messages[2]!.content as any[])[3]); // compaction 块
    // 工具参数叶子标记为 args
    expect(seen.filter((s) => s.args).length).toBe(3);
    expect(seen.find((s) => s.text === "hi 张伟")!.args).toBe(false);
  });

  test("没有要改的叶子时原对象不变（同一引用）", async () => {
    const body = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "无" }] };
    const copy = structuredClone(body);
    const n = await maskPayload("anthropic-messages", body, recorder().masker);
    expect(n).toBe(0);
    expect(body).toEqual(copy);
  });
});

describe("openai-responses / openai-codex-responses", () => {
  const mk = () => ({
    type: "response.create",
    model: "gpt",
    instructions: "指令 张伟",
    tools: [{ type: "function", name: "张伟", description: "张伟", parameters: { type: "object" } }],
    prompt_cache_key: "张伟",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev 张伟" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "用户 张伟" }, { type: "input_image", image_url: "data:张伟" }] },
      { role: "user", content: "简写 张伟" },
      { type: "reasoning", id: "rs_张伟", encrypted_content: enc, summary: [{ type: "summary_text", text: "思考 张伟" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "助手 张伟" }] },
      { type: "function_call", call_id: "call_张伟", name: "write", arguments: '{"path": "/a/张伟.txt", "content":"张伟 hi", "n": 2, "list":["张伟"]}' },
      { type: "function_call_output", call_id: "call_张伟", output: "输出 张伟" },
      { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "数组输出 张伟" }] },
      { type: "compaction", encrypted_content: enc },
      { type: "item_reference", id: "张伟" },
      { type: "custom_tool_call", call_id: "c3", name: "apply_patch", input: "补丁 张伟" },
      { type: "custom_tool_call_output", call_id: "c3", output: "ok 张伟" },
    ],
  });

  for (const fmt of ["openai-responses", "openai-codex-responses"] as const) {
    test(`${fmt}：文本叶子与 JSON 字符串参数`, async () => {
      const body = mk();
      const { masker, seen } = recorder();
      await maskPayload(fmt, body, masker);
      const ref = mk();
      expect(body.instructions).toBe("指令 <P>");
      expect(body.tools).toEqual(ref.tools);
      expect(body.prompt_cache_key).toBe("张伟");
      const i = body.input as any[];
      expect(i[0].content[0].text).toBe("dev <P>");
      expect(i[1].content[0].text).toBe("用户 <P>");
      expect(i[1].content[1]).toEqual((ref.input[1] as any).content[1]);
      expect(i[2].content).toBe("简写 <P>");
      expect(i[3]).toEqual(ref.input[3]); // reasoning 不碰
      expect(i[4].content[0].text).toBe("助手 <P>");
      // arguments 是 JSON 字符串：解析 → 逐叶子 → 序列化，键与非字符串值不变
      expect(JSON.parse(i[5].arguments)).toEqual({ path: "/a/<P>.txt", content: "<P> hi", n: 2, list: ["<P>"] });
      expect(i[5].call_id).toBe("call_张伟");
      expect(i[6].output).toBe("输出 <P>");
      expect(i[7].output[0].text).toBe("数组输出 <P>");
      expect(i[8]).toEqual(ref.input[8]);
      expect(i[9]).toEqual(ref.input[9]);
      expect(i[10].input).toBe("补丁 <P>");
      expect(i[11].output).toBe("ok <P>");
      expect(seen.filter((s) => s.args).map((s) => s.text).sort()).toEqual(["/a/张伟.txt", "补丁 张伟", "张伟", "张伟 hi"].sort());
    });
  }

  test("没有改动的 arguments 字符串保持原样（不重新序列化）", async () => {
    const args = '{ "a" :   "无" }';
    const body = { model: "m", input: [{ type: "function_call", call_id: "c", name: "x", arguments: args }] };
    await maskPayload("openai-responses", body, recorder().masker);
    expect(body.input[0]!.arguments).toBe(args);
  });

  test("arguments 不是合法 JSON：当普通文本遮", async () => {
    const body = { model: "m", input: [{ type: "function_call", call_id: "c", name: "x", arguments: "{坏 张伟" }] };
    await maskPayload("openai-responses", body, recorder().masker);
    expect(body.input[0]!.arguments).toBe("{坏 <P>");
  });

  test("input 是字符串", async () => {
    const body = { model: "m", input: "直接 张伟" };
    await maskPayload("openai-responses", body, recorder().masker);
    expect(body.input).toBe("直接 <P>");
  });
});

describe("openai chat completions", () => {
  test("content、tool_calls.arguments、tool 角色", async () => {
    const body = {
      model: "gpt",
      messages: [
        { role: "system", content: "sys 张伟" },
        { role: "user", content: [{ type: "text", text: "u 张伟" }, { type: "image_url", image_url: { url: "张伟" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_张伟", type: "function", function: { name: "write", arguments: '{"c":"张伟"}' } }] },
        { role: "tool", tool_call_id: "call_张伟", content: "结果 张伟" },
      ],
    };
    await maskPayload("openai-completions", body, recorder().masker);
    expect(body.messages[0]!.content).toBe("sys <P>");
    expect((body.messages[1]!.content as any[])[0].text).toBe("u <P>");
    expect((body.messages[1]!.content as any[])[1].image_url.url).toBe("张伟");
    expect(JSON.parse(body.messages[2]!.tool_calls![0]!.function.arguments)).toEqual({ c: "<P>" });
    expect(body.messages[2]!.tool_calls![0]!.id).toBe("call_张伟");
    expect(body.messages[3]!.content).toBe("结果 <P>");
  });
});

describe("非普通值与 $$…$$", () => {
  test("保留 BigInt / Uint8Array（devin 式对象不会被复制或序列化）", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const big = 12345678901234567890n;
    const body: any = {
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "张伟", big, bytes }] }],
      weird: { big, bytes },
    };
    await maskPayload("anthropic-messages", body, recorder().masker);
    expect(body.messages[0].content[0].text).toBe("<P>");
    expect(body.messages[0].content[0].big).toBe(big);
    expect(body.messages[0].content[0].bytes).toBe(bytes); // 同一个引用
    expect(body.weird.bytes).toBe(bytes);
  });

  test("遮挡器返回条数不对 → 抛错，不写回", async () => {
    const body = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "张伟" }] };
    await expect(maskPayload("anthropic-messages", body, { maskTexts: async () => [] })).rejects.toThrow();
    expect(body.messages[0]!.content).toBe("张伟");
  });

  test("遮挡器失败 → 抛错，不写回", async () => {
    const body = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "张伟" }] };
    await expect(maskPayload("anthropic-messages", body, { maskTexts: async () => Promise.reject(new Error("boom")) })).rejects.toThrow("boom");
    expect(body.messages[0]!.content).toBe("张伟");
  });

  test("请求体不是对象 → 抛错", async () => {
    await expect(maskPayload("anthropic-messages", "x", recorder().masker)).rejects.toThrow();
    await expect(maskPayload("anthropic-messages", null, recorder().masker)).rejects.toThrow();
  });
});

describe("api 与格式识别", () => {
  test("api → 格式；devin-agent 与其他一律不支持", () => {
    expect(formatForApi("anthropic-messages")).toBe("anthropic-messages");
    expect(formatForApi("openai-responses")).toBe("openai-responses");
    expect(formatForApi("openai-codex-responses")).toBe("openai-codex-responses");
    expect(formatForApi("openai-completions")).toBe("openai-completions");
    for (const api of ["devin-agent", "google-generative-ai", "bedrock-converse-stream", "toString", "constructor", "", undefined]) expect(formatForApi(api as string)).toBeUndefined();
  });

  test("detectFormat", () => {
    expect(detectFormat("/v1/messages", { model: "m", messages: [] })).toBe("anthropic-messages");
    expect(detectFormat("/v1/chat/completions", { model: "m", messages: [] })).toBe("openai-completions");
    expect(detectFormat("/v1/responses", { model: "m", input: "x" })).toBe("openai-responses");
    expect(detectFormat("/backend-api/codex/responses/compact", { model: "m", input: [] })).toBe("openai-responses");
    expect(detectFormat(undefined, { type: "response.create", model: "m", input: [] })).toBe("openai-codex-responses");
    expect(detectFormat(undefined, { model: "m", max_tokens: 5, system: "s", messages: [] })).toBe("anthropic-messages");
    expect(detectFormat(undefined, { model: "m", messages: [{ role: "user", content: "x" }] })).toBe("openai-completions");
    expect(detectFormat(undefined, { model: "m", input: [] })).toBe("openai-responses");
    // 不是 LLM 请求
    expect(detectFormat("/rpc", { jsonrpc: "2.0", method: "x", params: {} })).toBeUndefined();
    expect(detectFormat("/v1/oauth/token", { grant_type: "x", code: "y" })).toBeUndefined();
    expect(detectFormat(undefined, { messages: [] })).toBeUndefined();
    expect(detectFormat(undefined, [] as unknown as object)).toBeUndefined();
    expect(detectFormat(undefined, "x")).toBeUndefined();
  });
});
