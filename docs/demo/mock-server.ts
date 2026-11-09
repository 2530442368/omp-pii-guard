// 演示用的本地模拟服务端（不是真实模型）：只监听 127.0.0.1，实现 Anthropic Messages 的 SSE 流式接口。
// 收到请求就把“最后一条用户消息”的文本原样打印出来（右栏），回复是固定模板，原样引用收到的占位符。
// 用法：DEMO_LANG=zh|en DEMO_PORT=18765 bun docs/demo/mock-server.ts

const PORT = Number(process.env.DEMO_PORT ?? 18765);
const LANG = process.env.DEMO_LANG === "en" ? "en" : "zh";
const LOG = process.env.DEMO_LOG; // 可选：把完整请求体追加写到这个文件，调试用

const T = {
  zh: {
    head: "收到请求 #",
    body: "最后一条用户消息（原样）：",
    skipped: "（omp 附带的 <system-reminder> 提示已省略）",
    other: "旁路请求（非主对话），未展示内容",
    reply: (p: Record<string, string>) =>
      `已记录：联系人 ${p.PERSON ?? "（无）"}，电话 ${p.PHONE ?? "（无）"}，邮箱 ${p.EMAIL ?? "（无）"}，地址 ${p.ADDRESS ?? "（无）"}。`,
    none: "已收到，没有看到可引用的占位符。",
  },
  en: {
    head: "Request #",
    body: "Last user message (as received):",
    skipped: "(omp's own <system-reminder> hint omitted)",
    other: "side request (not the main chat), content not shown",
    reply: (p: Record<string, string>) =>
      `Noted: contact ${p.PERSON ?? "(none)"}, phone ${p.PHONE ?? "(none)"}, email ${p.EMAIL ?? "(none)"}, address ${p.ADDRESS ?? "(none)"}.`,
    none: "Received; no placeholder to quote.",
  },
}[LANG];

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;
const PLACEHOLDER = /\{\{([A-Z]+)_[a-z2-7]{8}\}\}/g;
let seq = 0;

interface Block {
  type?: string;
  text?: unknown;
}
interface Message {
  role?: string;
  content?: string | Block[];
}
interface RequestBody {
  model?: string;
  tools?: unknown[];
  messages?: Message[];
}

function lastUserText(body: RequestBody): string | undefined {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const parts = m.content.flatMap((c) => (c?.type === "text" && typeof c.text === "string" ? [c.text] : []));
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return undefined;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function stream(text: string, model: string, inTokens: number): Response {
  const id = "msg_demo_" + seq;
  const parts = text.match(/.{1,6}/gsu) ?? [text];
  const enc = new TextEncoder();
  const events = [
    sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 1 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...parts.map((p) => sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.max(1, parts.length) } }),
    sse("message_stop", { type: "message_stop" }),
  ];
  const body = new ReadableStream({
    async start(ctrl) {
      for (const e of events) {
        ctrl.enqueue(enc.encode(e));
        await Bun.sleep(40);
      }
      ctrl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 100 });
    if (req.method === "POST" && url.pathname.endsWith("/messages")) {
      const raw = await req.text();
      let body: RequestBody;
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad json" } }, { status: 400 });
      }
      if (LOG) await Bun.write(LOG, (await Bun.file(LOG).text().catch(() => "")) + raw + "\n");
      const model = typeof body.model === "string" ? body.model : "mock";
      // 主对话请求：带工具定义（omp 的标题生成等旁路请求没有 tools）
      const main = Array.isArray(body.tools) && body.tools.length > 0;
      const text = lastUserText(body) ?? "";
      seq++;
      const bar = "─".repeat(Math.max(8, (process.stdout.columns ?? 60) - 2));
      if (main) {
        console.log(`\x1b[1;33m${bar}\n${T.head}${seq}  POST ${url.pathname}\x1b[0m`);
        console.log(`\x1b[2m${T.body}\x1b[0m`);
        // 只省略 omp 自己附加的 <system-reminder> 块（日期、工作目录），用户消息本身一字不改
        const shown = text.replace(REMINDER, "");
        if (shown !== text) console.log(`\x1b[2m${T.skipped}\x1b[0m`);
        console.log(shown.replace(PLACEHOLDER, (m) => `\x1b[1;36m${m}\x1b[0m`));
      } else {
        console.log(`\x1b[2m${T.head}${seq}  ${T.other}\x1b[0m`);
      }
      const found: Record<string, string> = {};
      for (const m of text.matchAll(PLACEHOLDER)) found[m[1]!] ??= m[0];
      const reply = main ? (Object.keys(found).length > 0 ? T.reply(found) : T.none) : "Demo";
      return stream(reply, model, Math.ceil(raw.length / 4));
    }
    return Response.json({ type: "error", error: { type: "not_found_error", message: "not found" } }, { status: 404 });
  },
});

console.log(`\x1b[2m${LANG === "zh" ? "模拟服务端已就绪（127.0.0.1:" : "mock server ready (127.0.0.1:"}${PORT})\x1b[0m`);
