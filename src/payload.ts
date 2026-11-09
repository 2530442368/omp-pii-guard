// 请求体遍历：只收集“用户能写进去的文本”的字符串叶子（用户/助手文本、工具结果文本、工具调用参数、
// system/instructions），交给遮挡器，再就地写回。其余一律不碰：thinking/redacted_thinking/signature、
// encrypted_content、compaction 块、工具定义 schema、图片/二进制、id/name/model 等结构字段。
// 非普通值（BigInt、Uint8Array 等）原样保留；就地修改，不复制对象。

export type Format = "anthropic-messages" | "openai-responses" | "openai-codex-responses" | "openai-completions";

/** omp 的 `Model.api` → 请求体格式；不在表里的 api 一律失败（fail-closed）。 */
export const API_FORMATS: Readonly<Record<string, Format>> = {
  "anthropic-messages": "anthropic-messages",
  "openai-responses": "openai-responses",
  "openai-codex-responses": "openai-codex-responses",
  "openai-completions": "openai-completions",
};

export function formatForApi(api: string | undefined): Format | undefined {
  return api !== undefined && Object.hasOwn(API_FORMATS, api) ? API_FORMATS[api] : undefined;
}

export interface TextItem {
  text: string;
  /** 文本是否为工具调用参数（modelSpans 的 args 选项）。 */
  args: boolean;
}

/** 遮挡器：返回与入参等长、一一对应的遮挡后文本。 */
export interface TextMasker {
  maskTexts(items: readonly TextItem[]): Promise<string[]>;
}

interface Leaf extends TextItem {
  set(v: string): void;
  /** 属于哪个 JSON 字符串参数组（arguments），写回后要重新序列化。 */
  group?: JsonGroup;
}

interface JsonGroup {
  holder: Record<string, unknown>;
  key: string;
  parsed: unknown;
  dirty: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isPlain = (v: unknown): v is Obj => isObj(v) && Object.getPrototypeOf(v) === Object.prototype;

class Collector {
  readonly leaves: Leaf[] = [];
  readonly groups: JsonGroup[] = [];

  /** holder[key] 是字符串时记为叶子。 */
  at(holder: Obj, key: string, args = false, group?: JsonGroup): void {
    const v = holder[key];
    if (typeof v !== "string" || v.length === 0) return;
    this.leaves.push({
      text: v,
      args,
      group,
      set: (s) => {
        holder[key] = s;
        if (group) group.dirty = true;
      },
    });
  }

  /** 深度遍历 holder[key]：所有字符串叶子（键不动）。 */
  deep(holder: Obj | unknown[], key: string | number, args: boolean, group?: JsonGroup): void {
    const v = (holder as Obj)[key as string];
    if (typeof v === "string") {
      this.at(holder as Obj, key as string, args, group);
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) this.deep(v, i, args, group);
    } else if (isPlain(v)) {
      for (const k of Object.keys(v)) this.deep(v, k, args, group);
    }
  }

  /** holder[key] 是 JSON 字符串（Responses 的 function_call.arguments）：解析后逐叶子遮，写回时重新序列化。 */
  jsonString(holder: Obj, key: string): void {
    const v = holder[key];
    if (typeof v !== "string" || v.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      this.at(holder, key, true); // 不是合法 JSON：当普通文本遮
      return;
    }
    if (typeof parsed === "string") {
      this.at(holder, key, true);
      return;
    }
    const g: JsonGroup = { holder, key, parsed, dirty: false };
    this.groups.push(g);
    const box: Obj = { v: parsed };
    this.deep(box, "v", true, g);
    g.parsed = box.v;
  }
}

/** 文本块数组或字符串内容：text 类块的 text。 */
function textParts(c: Collector, parent: Obj, key: string, types: readonly string[], args = false): void {
  const v = parent[key];
  if (typeof v === "string") c.at(parent, key, args);
  else if (Array.isArray(v)) {
    for (const part of v) if (isObj(part) && typeof part.type === "string" && types.includes(part.type)) c.at(part, "text", args);
  }
}

const TEXT_TYPES = ["text", "input_text", "output_text"] as const;

/** anthropic-messages 与 openai chat completions（两者的字段互不冲突，一个遍历器都处理）。 */
function walkMessages(c: Collector, body: Obj): void {
  textParts(c, body, "system", ["text"]);
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const content = msg.content;
    if (typeof content === "string") c.at(msg, "content");
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObj(block)) continue;
        switch (block.type) {
          case "text":
            c.at(block, "text");
            break;
          case "tool_use":
          case "server_tool_use":
          case "mcp_tool_use":
            c.deep(block, "input", true);
            break;
          case "tool_result":
          case "mcp_tool_result":
            textParts(c, block, "content", ["text"]);
            break;
          case "search_result":
            textParts(c, block, "content", ["text"]);
            break;
          case "document":
            if (isObj(block.source) && block.source.type === "text") c.at(block.source, "data");
            break;
          default:
            // thinking、redacted_thinking、image、compaction、其他：不碰
            break;
        }
      }
    }
    // openai chat completions 的工具调用
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) if (isObj(call) && isObj(call.function)) c.jsonString(call.function, "arguments");
    }
    if (isObj(msg.function_call)) c.jsonString(msg.function_call, "arguments");
  }
}

function walkResponseItem(c: Collector, item: Obj): void {
  switch (item.type) {
    case undefined:
    case "message":
      textParts(c, item, "content", TEXT_TYPES);
      break;
    case "function_call":
      c.jsonString(item, "arguments");
      break;
    case "function_call_output":
    case "custom_tool_call_output":
      textParts(c, item, "output", TEXT_TYPES);
      break;
    case "custom_tool_call":
      c.at(item, "input", true);
      break;
    case "mcp_call":
      c.jsonString(item, "arguments");
      c.at(item, "output");
      break;
    default:
      // reasoning、compaction、item_reference、各类 *_call（搜索、计算机…）：不碰
      break;
  }
}

/** openai-responses 与 openai-codex-responses（ws 的 response.create 帧同样的键）。 */
function walkResponses(c: Collector, body: Obj): void {
  for (const key of ["instructions", "input"] as const) {
    const v = body[key];
    if (typeof v === "string") c.at(body, key);
    else if (Array.isArray(v)) for (const item of v) if (isObj(item)) walkResponseItem(c, item);
  }
}

/**
 * 遮挡请求体里的文本字符串叶子（就地）。返回被改动的叶子数。
 * 非 JSON 可表示的值（BigInt、Uint8Array）不被触碰。
 */
export async function maskPayload(format: Format, body: unknown, masker: TextMasker): Promise<number> {
  if (!isObj(body)) throw new Error("请求体不是对象");
  const c = new Collector();
  if (format === "anthropic-messages" || format === "openai-completions") walkMessages(c, body);
  else walkResponses(c, body);
  if (c.leaves.length === 0) return 0;
  const out = await masker.maskTexts(c.leaves.map((l) => ({ text: l.text, args: l.args })));
  if (out.length !== c.leaves.length) throw new Error("遮挡器返回的条数不对");
  let changed = 0;
  c.leaves.forEach((l, i) => {
    const s = out[i]!;
    if (s !== l.text) {
      l.set(s);
      changed++;
    }
  });
  for (const g of c.groups) if (g.dirty) g.holder[g.key] = JSON.stringify(g.parsed);
  return changed;
}

/**
 * 按请求体（及可选的 URL 路径）识别 LLM 请求的格式；认不出返回 undefined。
 * 只认：有 model 字符串，且带 messages 数组或 input（字符串/数组）；或 type 为 response.create。
 */
export function detectFormat(pathname: string | undefined, body: unknown): Format | undefined {
  if (!isObj(body)) return undefined;
  if (body.type === "response.create") return "openai-codex-responses";
  if (typeof body.model !== "string") return undefined;
  const path = (pathname ?? "").split("?")[0]!;
  const hasMessages = Array.isArray(body.messages);
  const hasInput = Array.isArray(body.input) || typeof body.input === "string";
  if (hasMessages && /\/messages$/.test(path)) return "anthropic-messages";
  if (hasMessages && /\/chat\/completions$/.test(path)) return "openai-completions";
  if (hasInput && /\/responses(\/|$)/.test(path)) return "openai-responses";
  if (hasMessages && !hasInput) {
    const anthropic =
      "system" in body ||
      "anthropic_version" in body ||
      (body.messages as unknown[]).some(
        (m) => isObj(m) && Array.isArray(m.content) && m.content.some((b) => isObj(b) && /^(tool_use|tool_result|thinking|redacted_thinking)$/.test(String(b.type))),
      );
    return anthropic || typeof body.max_tokens === "number" ? "anthropic-messages" : "openai-completions";
  }
  if (hasInput && !hasMessages) return "openai-responses";
  return undefined;
}
