// A11（单测部分）：网络层只改写识别为 LLM 请求的体，其他请求字节不变；gzip 体改写后可解压且 Content-Length 正确；
// 同一 WebSocket 连续多帧顺序不变；识别失败时请求未发出。用本机服务器验证真实字节。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as zlib from "node:zlib";
import { maskPayload } from "../src/payload.ts";
import { BLOCKED_MESSAGE, addLlmOrigin, getTransport, installTransport, isInferencePath, isKnownOrigin, maskBytes, maskFrame, originOf, transportProblems, type TransportDeps } from "../src/transport.ts";

interface Got {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let server: http.Server;
let port = 0;
let got: Got[] = [];
let failures: string[] = [];
let delayFirst = 0;
let maskCalls = 0;
let failMask = false;
/** 本机测试服务器是否登记为已知 LLM 服务（strict）；未知来源的用例把它设为 false。 */
let knownMode = true;
const httpOrigin = () => `http://127.0.0.1:${port}`;

const deps: TransportDeps = {
  enabled: () => true,
  maskBody: async (format, body) => {
    maskCalls++;
    if (failMask) throw new Error("模型不可用");
    const my = maskCalls;
    if (delayFirst > 0 && my === 1) await new Promise((r) => setTimeout(r, delayFirst));
    return maskPayload(format, body, { maskTexts: async (items) => items.map((i) => i.text.replaceAll("张伟", "{{PERSON_aaaaaaaa}}")) });
  },
  fail: (where, err) => {
    failures.push(`${where}: ${String((err as Error).message)}`);
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  installTransport(deps);
});

afterAll(() => {
  getTransport().deps = { ...deps, enabled: () => false };
  server.close();
});

beforeEach(() => {
  got = [];
  knownMode = true;
  addLlmOrigin(httpOrigin()); // 默认把本机测试服务器当已知 LLM 服务（strict）；未知来源的用例自己去掉
  failures = [];
  delayFirst = 0;
  maskCalls = 0;
  failMask = false;
  getTransport().deps = deps;
});

const llmBody = () => ({ model: "claude", max_tokens: 10, messages: [{ role: "user", content: "你好 张伟，请记住" }] });

interface PostResult {
  status?: number;
  headers?: http.IncomingHttpHeaders;
  body?: string;
  error?: Error;
  /** 收到的是网络层合成的 422（pii_guard_blocked）。 */
  blocked: boolean;
}

function post(path: string, body: Buffer | string, headers: Record<string, string | number> = {}): Promise<PostResult> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, body: text, blocked: res.statusCode === 422 && text.includes("pii_guard_blocked") });
      });
    });
    req.on("error", (error) => resolve({ error, blocked: false }));
    req.end(body);
  });
}

describe("包装在位", () => {
  test("自检：全部在位", () => {
    expect(transportProblems()).toEqual([]);
    installTransport(deps); // 幂等
    expect(transportProblems()).toEqual([]);
  });
});

describe("ClientRequest", () => {
  test("gzip 的 LLM 请求：改写后可解压、Content-Length 等于实际字节数", async () => {
    const raw = Buffer.from(JSON.stringify(llmBody()));
    const gz = zlib.gzipSync(raw);
    const r = await post("/v1/messages", gz, { "content-type": "application/json", "content-encoding": "gzip", "content-length": gz.length });
    expect(r.status).toBe(200);
    expect(got.length).toBe(1);
    const g = got[0]!;
    const text = zlib.gunzipSync(g.body).toString("utf8");
    expect(JSON.parse(text).messages[0].content).toBe("你好 {{PERSON_aaaaaaaa}}，请记住");
    expect(Number(g.headers["content-length"])).toBe(g.body.length);
    expect(g.body.length).not.toBe(gz.length);
  });

  test("未压缩的 LLM 请求：改写，Content-Length 等于实际字节数", async () => {
    const raw = Buffer.from(JSON.stringify(llmBody()));
    await post("/v1/messages/count_tokens", raw, { "content-type": "application/json", "content-length": raw.length });
    const g = got[0]!;
    expect(JSON.parse(g.body.toString()).messages[0].content).toBe("你好 {{PERSON_aaaaaaaa}}，请记住");
    expect(Number(g.headers["content-length"])).toBe(g.body.length);
  });

  test("S-F7：路径不是推理端点，同形 JSON 字节不变（不论主机）", async () => {
    const raw = Buffer.from(JSON.stringify(llmBody()));
    for (const p of ["/archive", "/some/where", "/v1/messages/batches", "/v1/models", "/oauth/token"]) await post(p, raw, { "content-type": "application/json", "content-length": raw.length });
    expect(got.length).toBe(5);
    expect(got.every((g) => g.body.equals(raw))).toBe(true);
    expect(maskCalls).toBe(0);
  });

  test("isInferencePath", () => {
    for (const p of ["/v1/messages", "/v1/messages/count_tokens", "/messages", "/backend-api/codex/responses", "/v1/responses/compact", "/v1/chat/completions", "/v1/completions", "/gw/v1/messages?beta=true", "/v1/responses/"]) expect(isInferencePath(p)).toBe(true);
    for (const p of ["/v1/messages/batches", "/v1/models", "/oauth/token", "/archive", "/v1/responses/abc", "/xmessages", undefined]) expect(isInferencePath(p)).toBe(false);
  });

  test("br 与 deflate 同样往返", async () => {
    for (const [enc, c, d] of [["br", zlib.brotliCompressSync, zlib.brotliDecompressSync], ["deflate", zlib.deflateSync, zlib.inflateSync]] as const) {
      got = [];
      const gz = c(Buffer.from(JSON.stringify(llmBody())));
      await post("/v1/messages", gz, { "content-encoding": enc, "content-length": gz.length });
      expect(JSON.parse(d(got[0]!.body).toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
    }
  });

  test("没有要遮的内容：字节与原来完全一致（含压缩）", async () => {
    const body = { model: "claude", max_tokens: 10, messages: [{ role: "user", content: "没有什么" }] };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(body)));
    await post("/v1/messages", gz, { "content-encoding": "gzip", "content-length": gz.length });
    expect(got[0]!.body.equals(gz)).toBe(true);
  });

  test("多次 write 再 end：合并后处理", async () => {
    const raw = Buffer.from(JSON.stringify(llmBody()));
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.write(raw.subarray(0, 10));
      req.write(raw.subarray(10, 30));
      req.end(raw.subarray(30));
    });
    expect(JSON.parse(got[0]!.body.toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
  });

  test("非 LLM 请求字节不变：二进制、JSON-RPC、LLM 形状但路径不是推理端点", async () => {
    const bin = Buffer.from([0x00, 0x01, 0x7b, 0xff, 0xfe, 0x10]);
    await post("/upload", bin, { "content-type": "application/octet-stream", "content-length": bin.length });
    const rpc = Buffer.from('{"jsonrpc":"2.0","method":"x","params":{"name":"张伟"}}');
    await post("/rpc", rpc, { "content-type": "application/json", "content-length": rpc.length });
    const shaped = Buffer.from(JSON.stringify(llmBody()));
    await post("/other", shaped, { "content-type": "application/json", "content-length": shaped.length });
    expect(got.map((g) => g.body.equals(bin) || g.body.equals(rpc) || g.body.equals(shaped))).toEqual([true, true, true]);
    expect(maskCalls).toBe(0);
  });

  test("S-F5：推理端点上认不出的体（二进制、非 JSON、认不出格式的 JSON）不发出；同主机的 oauth 路径放行", async () => {
    const bin = Buffer.from([0x00, 0x01, 0x7b, 0xff]);
    expect((await post("/v1/messages", bin, { "content-length": bin.length })).blocked).toBe(true);
    const text = Buffer.from("plain text 张伟");
    expect((await post("/v1/responses", text, { "content-length": text.length })).blocked).toBe(true);
    const oauth = Buffer.from('{"grant_type":"refresh_token","refresh_token":"x"}');
    expect((await post("/v1/messages", oauth, { "content-length": oauth.length })).blocked).toBe(true);
    expect(failures.some((f) => f.includes("认不出"))).toBe(true); // 具体原因给界面提示，不进错误文本
    expect(got.length).toBe(0);
    await post("/oauth/token", oauth, { "content-length": oauth.length });
    expect(got[0]!.body.equals(oauth)).toBe(true);
  });

  test("遮挡失败：请求不发出（服务器 0 条），error 事件带原因，并提示", async () => {
    failMask = true;
    const raw = Buffer.from(JSON.stringify(llmBody()));
    const r = await post("/v1/messages", raw, { "content-length": raw.length });
    expect(r.blocked).toBe(true);
    expect(failures[0]).toContain("模型不可用");
    expect(got.length).toBe(0);
    expect(failures[0]).toContain("http");
  });

  test("无法解码的体（坏 gzip）发往 LLM 路径：不发出", async () => {
    const bad = Buffer.from("not gzip at all");
    const r = await post("/v1/messages", bad, { "content-encoding": "gzip", "content-length": bad.length });
    expect(r.blocked).toBe(true);
    expect(got.length).toBe(0);
  });

  test("不支持的 content-encoding（zstd）发往 LLM 路径：不发出", async () => {
    const body = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
    const r = await post("/v1/messages", body, { "content-encoding": "zstd", "content-length": body.length });
    expect(r.blocked).toBe(true);
    expect(failures[0]).toContain("zstd");
    expect(got.length).toBe(0);
  });

  test("关闭（enabled=false）：原样放行", async () => {
    getTransport().deps = { ...deps, enabled: () => false };
    const raw = Buffer.from(JSON.stringify(llmBody()));
    await post("/v1/messages", raw, { "content-length": raw.length });
    expect(got[0]!.body.equals(raw)).toBe(true);
  });
});

describe("fetch", () => {
  const url = () => `http://127.0.0.1:${port}`;

  test("字符串 JSON 体：改写，服务器收到遮挡后的体", async () => {
    await fetch(`${url()}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(llmBody()) });
    expect(JSON.parse(got[0]!.body.toString()).messages[0].content).toBe("你好 {{PERSON_aaaaaaaa}}，请记住");
    expect(Number(got[0]!.headers["content-length"])).toBe(got[0]!.body.length);
  });

  test("Uint8Array 体（含 gzip）：改写、重压缩、Content-Length 正确", async () => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(llmBody())));
    await fetch(`${url()}/v1/messages`, { method: "POST", headers: { "content-encoding": "gzip", "content-length": String(gz.length) }, body: gz });
    const g = got[0]!;
    expect(JSON.parse(zlib.gunzipSync(g.body).toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
    expect(Number(g.headers["content-length"])).toBe(g.body.length);
  });

  test("Request 对象作为入参", async () => {
    await fetch(new Request(`${url()}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(llmBody()) }));
    expect(JSON.parse(got[0]!.body.toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
  });

  test("S-F3：fetch(Request, init)——体来自 init、content-encoding 来自 Request：按实际生效的头解码、改写", async () => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(llmBody())));
    await fetch(new Request(`${url()}/v1/messages`, { method: "POST", headers: { "content-encoding": "gzip", "content-type": "application/json" } }), { body: gz });
    const g = got[0]!;
    expect(g.headers["content-encoding"]).toBe("gzip");
    const text = zlib.gunzipSync(g.body).toString();
    expect(text).not.toContain("张伟");
    expect(JSON.parse(text).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
  });

  test("S-F3：init.headers 覆盖 Request 的头（替换而非合并）；init.body 覆盖 Request 的体", async () => {
    const req = new Request(`${url()}/v1/messages`, { method: "POST", headers: { "content-encoding": "gzip" }, body: zlib.gzipSync(Buffer.from("{}")) });
    await fetch(req, { headers: { "content-type": "application/json" }, body: JSON.stringify(llmBody()) });
    expect(got[0]!.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(got[0]!.body.toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
  });

  test("S-F5：推理端点上的 Blob、ReadableStream、URLSearchParams 体完整读取后遮挡；认不出的不发出", async () => {
    const json = JSON.stringify(llmBody());
    await fetch(`${url()}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: new Blob([json]) });
    expect(JSON.parse(got[0]!.body.toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(json.slice(0, 20)));
        c.enqueue(new TextEncoder().encode(json.slice(20)));
        c.close();
      },
    });
    await fetch(`${url()}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(JSON.parse(got[1]!.body.toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
    // 没有要遮的流：照常发出（体经合成的 Request 原样送出）
    const quiet = JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "没有什么" }] });
    const s2 = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(quiet)); c.close(); } });
    await fetch(`${url()}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: s2, duplex: "half" } as RequestInit);
    expect(got[2]!.body.toString()).toBe(quiet);
    const before = got.length;
    for (const body of [new Blob(["not json 张伟"]), new URLSearchParams({ a: "张伟" })]) {
      const r = await fetch(`${url()}/v1/messages`, { method: "POST", body });
      expect(r.status).toBe(422);
    }
    expect(got.length).toBe(before);
  });

  test("其他请求字节不变：二进制、非 LLM JSON、GET", async () => {
    const bin = new Uint8Array([0, 1, 2, 0x7b, 255]);
    await fetch(`${url()}/up`, { method: "POST", body: bin });
    const rpc = '{"jsonrpc":"2.0","method":"x","params":{"name":"张伟"}}';
    await fetch(`${url()}/rpc`, { method: "POST", body: rpc });
    await fetch(`${url()}/get?x=张伟`);
    expect(got[0]!.body.equals(Buffer.from(bin))).toBe(true);
    expect(got[1]!.body.toString()).toBe(rpc);
    expect(got[2]!.method).toBe("GET");
    expect(maskCalls).toBe(0);
  });

  test("非推理端点的表单、Blob、流体原样放行（不读取、不消耗）", async () => {
    const fd = new FormData();
    fd.set("a", "张伟");
    await fetch(`${url()}/form`, { method: "POST", body: fd });
    await fetch(`${url()}/blob`, { method: "POST", body: new Blob(['{"model":"m","messages":[{"role":"user","content":"张伟"}]}']) });
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("abc")); c.close(); } });
    await fetch(`${url()}/stream`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(got.length).toBe(3);
    expect(got[2]!.body.toString()).toBe("abc");
    expect(maskCalls).toBe(0);
  });

  test("遮挡失败：fetch 返回 422（不拒绝），服务器 0 条，并提示", async () => {
    failMask = true;
    expect((await fetch(`${url()}/v1/messages`, { method: "POST", body: JSON.stringify(llmBody()) })).status).toBe(422);
    expect(got.length).toBe(0);
    expect(failures[0]).toContain("fetch");
  });

  test("zstd 的 LLM 请求：拒绝；非 LLM 路径的 zstd 放行", async () => {
    const zbody = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2]);
    const blocked = await fetch(`${url()}/v1/messages`, { method: "POST", headers: { "content-encoding": "zstd" }, body: zbody });
    expect(blocked.status).toBe(422);
    expect(failures[0]).toContain("zstd");
    expect(got.length).toBe(0);
    await fetch(`${url()}/other`, { method: "POST", headers: { "content-encoding": "zstd" }, body: zbody });
    expect(got.length).toBe(1);
  });
});

describe("WebSocket", () => {
  interface WsServer {
    url: string;
    frames: string[];
    stop(): void;
    closed: Promise<void>;
  }
  function wsServer(path = "/backend-api/codex/responses"): WsServer {
    const frames: string[] = [];
    const { promise: closed, resolve } = Promise.withResolvers<void>();
    const s = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(_ws, m) {
          frames.push(String(m));
        },
        close() {
          resolve();
        },
      },
    });
    const url = `ws://127.0.0.1:${s.port}${path}`;
    if (knownMode) addLlmOrigin(url);
    return { url, frames, stop: () => s.stop(true), closed };
  }
  const open = (url: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(ws);
      ws.onerror = (e) => reject(e);
    });
  const frame = (n: number) => JSON.stringify({ type: "response.create", model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `第 ${n} 帧 张伟` }] }] });

  test("response.create 帧被遮挡；控制帧放行；顺序不变（第一帧处理最慢）", async () => {
    const s = wsServer();
    delayFirst = 80;
    const ws = await open(s.url);
    ws.send(frame(1));
    ws.send('{"type":"response.cancel","response_id":"resp_1","event_id":"e1"}');
    ws.send(frame(2));
    ws.send('{"type":"input_audio_buffer.clear","previous_response_id":null,"n":3,"flag":true}');
    ws.send(frame(3));
    await Bun.sleep(300);
    expect(s.frames.length).toBe(5);
    expect(JSON.parse(s.frames[0]!).input[0].content[0].text).toBe("第 1 帧 {{PERSON_aaaaaaaa}}");
    expect(s.frames[1]).toBe('{"type":"response.cancel","response_id":"resp_1","event_id":"e1"}');
    expect(JSON.parse(s.frames[2]!).input[0].content[0].text).toBe("第 2 帧 {{PERSON_aaaaaaaa}}");
    expect(s.frames[3]).toBe('{"type":"input_audio_buffer.clear","previous_response_id":null,"n":3,"flag":true}'); // 字符串值只在 type/id 类键下的控制帧：原样
    expect(JSON.parse(s.frames[4]!).input[0].content[0].text).toBe("第 3 帧 {{PERSON_aaaaaaaa}}");
    ws.close();
    s.stop();
  });

  test("S-F7：路径不是推理端点的连接，同形帧字节不变，非 JSON 同步发出", async () => {
    const s = wsServer("/socket");
    const ws = await open(s.url);
    ws.send(frame(1));
    ws.send("hello");
    await Bun.sleep(50);
    expect(s.frames).toEqual([frame(1), "hello"]);
    expect(maskCalls).toBe(0);
    ws.close();
    s.stop();
  });

  test("S-F5：推理端点上的二进制帧按 UTF-8 解码后遮挡；无法解码或认不出的帧不发出并关闭连接", async () => {
    const s = wsServer();
    const ws = await open(s.url);
    ws.send(new TextEncoder().encode(frame(1)));
    ws.send(new Blob([frame(2)]));
    await Bun.sleep(150);
    expect(s.frames.length).toBe(2);
    expect(JSON.parse(s.frames[0]!).input[0].content[0].text).toBe("第 1 帧 {{PERSON_aaaaaaaa}}");
    expect(JSON.parse(s.frames[1]!).input[0].content[0].text).toBe("第 2 帧 {{PERSON_aaaaaaaa}}");
    ws.send(new Uint8Array([0xff, 0xfe, 0x00]));
    await Promise.race([s.closed, Bun.sleep(1000)]);
    expect(s.frames.length).toBe(2);
    expect(failures.some((f) => f.includes("WebSocket"))).toBe(true);
    s.stop();
  });

  test("S-F5：推理端点上的非 JSON 文本帧、带内容字段但认不出格式的帧不发出", async () => {
    for (const bad of ["ping", '{"type":"x","input":"张伟"}']) {
      failures = [];
      const s = wsServer();
      const ws = await open(s.url);
      ws.send(bad);
      await Promise.race([s.closed, Bun.sleep(1000)]);
      expect(s.frames.length).toBe(0);
      expect(failures.length).toBe(1);
      s.stop();
    }
  });

  test("遮挡失败：该帧与之后的帧都不发出，连接被关闭，并提示", async () => {
    const s = wsServer();
    const ws = await open(s.url);
    failMask = true;
    ws.send(frame(1));
    ws.send(frame(2));
    await Promise.race([s.closed, Bun.sleep(1000)]);
    expect(s.frames.length).toBe(0);
    expect(ws.readyState).toBeGreaterThanOrEqual(2);
    expect(failures.some((f) => f.includes("WebSocket"))).toBe(true);
    s.stop();
  });
});

describe("maskBytes", () => {
  test("不改动 → undefined（调用方放行原字节）", async () => {
    const buf = Buffer.from(JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "无" }] }));
    expect(await maskBytes(deps, buf, "", "/v1/messages", true)).toBeUndefined();
  });
  test("前导空白的 JSON 也识别；非 UTF-8 抛错", async () => {
    const buf = Buffer.from("  \n" + JSON.stringify(llmBody()));
    const out = await maskBytes(deps, buf, "", "/v1/messages", true);
    expect(JSON.parse(Buffer.from(out!).toString()).messages[0].content).toContain("{{PERSON_");
    await expect(maskBytes(deps, Buffer.from([0x7b, 0xff, 0xfe]), "", "/v1/messages", true)).rejects.toThrow("UTF-8");
    expect(await maskBytes(deps, Buffer.from([0x7b, 0xff, 0xfe]), "", "/v1/messages", false)).toBeUndefined(); // 未知主机：放行
  });
});

describe("S-F7（第 1、2 轮）：已知 LLM 服务（origin）+ 推理路径 才 fail-closed，未知来源按体形状判定", () => {
  const known = () => {
    knownMode = true;
    addLlmOrigin(httpOrigin());
  };
  const unknown = () => {
    knownMode = false;
    getTransport().origins.delete(httpOrigin());
  };
  const mcpRpc = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"who":"张伟"}}}');
  const chat = Buffer.from('{"channel":1,"content":"张伟你好","author":{"id":7}}');

  test("originOf / isKnownOrigin：协议 + 主机 + 有效端口；默认端口、大小写、ws→http、wss→https、IPv6", () => {
    expect(originOf("https://API.Anthropic.com/v1/messages")).toBe("https://api.anthropic.com:443");
    expect(originOf("http://x.example")).toBe("http://x.example:80");
    expect(originOf("wss://chatgpt.com/backend-api/codex/responses")).toBe("https://chatgpt.com:443");
    expect(originOf("ws://127.0.0.1:3425/x")).toBe("http://127.0.0.1:3425");
    expect(originOf("http://[::1]:3000/")).toBe("http://[::1]:3000");
    expect(originOf("file:///x")).toBe("");
    expect(originOf("not a url")).toBe("");
    for (const u of ["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/responses", "wss://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com:443/x"]) expect(isKnownOrigin(u)).toBe(true);
    // 协议、端口不同都不是同一个来源
    for (const u of ["http://api.anthropic.com/v1/messages", "https://api.anthropic.com:8443/v1/messages", "http://chatgpt.com:443/x", "https://evil-api.anthropic.com/x", "http://127.0.0.1:8080/messages"]) expect(isKnownOrigin(u)).toBe(false);
    addLlmOrigin("https://gw.example:8443/v1");
    expect(isKnownOrigin("https://gw.example:8443/other")).toBe(true);
    expect(isKnownOrigin("https://gw.example/other")).toBe(false);
    expect(isKnownOrigin("https://gw.example:8444/other")).toBe(false);
    getTransport().origins.delete(originOf("https://gw.example:8443"));
  });

  test("同主机不同端口：登记端口 A 的本机网关，端口 B 上的 MCP /messages JSON-RPC 原样放行（ClientRequest、fetch、WebSocket）", async () => {
    known(); // 端口 A（本测试服务器）是已知 LLM 服务
    // 端口 B：另起一个服务器，不登记
    const other: Got[] = [];
    const b = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        other.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    const portB = (b.address() as AddressInfo).port;
    expect(portB).not.toBe(port);
    try {
      // A：认不出的体不发出
      expect((await post("/messages", mcpRpc, { "content-length": mcpRpc.length })).blocked).toBe(true);
      // B：原样放行
      await new Promise<void>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: portB, path: "/messages", method: "POST", headers: { "content-type": "application/json", "content-length": mcpRpc.length } }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.end(mcpRpc);
      });
      await fetch(`http://127.0.0.1:${portB}/messages`, { method: "POST", body: mcpRpc.toString() });
      expect(other.map((o) => o.body.toString())).toEqual([mcpRpc.toString(), mcpRpc.toString()]);
      expect(got.length).toBe(0);
      // WebSocket：另一个端口上的 /responses 连接（没登记）：非 JSON 与内容字符串帧原样放行
      const frames: string[] = [];
      const s = Bun.serve({ port: 0, fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })), websocket: { message: (_w, m) => void frames.push(String(m)) } });
      try {
        expect(isKnownOrigin(`ws://127.0.0.1:${s.port}/responses`)).toBe(false);
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const w = new WebSocket(`ws://127.0.0.1:${s.port}/responses`);
          w.onopen = () => resolve(w);
          w.onerror = (e) => reject(e);
        });
        ws.send("ping");
        ws.send('{"type":"x","text":"张伟"}');
        await Bun.sleep(150);
        expect(frames).toEqual(["ping", '{"type":"x","text":"张伟"}']);
        ws.close();
      } finally {
        s.stop(true);
      }
    } finally {
      b.close();
    }
  });

  test("ClientRequest：未知主机 /channels/1/messages 普通 JSON、MCP SSE /messages 的 JSON-RPC 原样放行", async () => {
    unknown();
    const r1 = await post("/channels/1/messages", chat, { "content-type": "application/json", "content-length": chat.length });
    const r2 = await post("/messages", mcpRpc, { "content-type": "application/json", "content-length": mcpRpc.length });
    const bin = Buffer.from([0, 1, 0x7b, 0xff]);
    const r3 = await post("/v1/messages", bin, { "content-length": bin.length });
    const bad = Buffer.from("not gzip");
    const r4 = await post("/v1/messages", bad, { "content-encoding": "gzip", "content-length": bad.length });
    expect([r1.error, r2.error, r3.error, r4.error]).toEqual([undefined, undefined, undefined, undefined]);
    expect(got.length).toBe(4);
    expect(got[0]!.body.equals(chat)).toBe(true);
    expect(got[1]!.body.equals(mcpRpc)).toBe(true);
    expect(got[2]!.body.equals(bin)).toBe(true);
    expect(got[3]!.body.equals(bad)).toBe(true);
    expect(maskCalls).toBe(0);
  });

  test("ClientRequest：未知主机上 LLM 形状的体照常遮挡；遮挡失败仍不发出", async () => {
    unknown();
    const raw = Buffer.from(JSON.stringify(llmBody()));
    await post("/v1/messages", raw, { "content-length": raw.length });
    expect(JSON.parse(got[0]!.body.toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
    failMask = true;
    const r = await post("/v1/messages", raw, { "content-length": raw.length });
    expect(r.blocked).toBe(true);
    expect(got.length).toBe(1);
  });

  test("ClientRequest：已知主机上认不出的体不发出", async () => {
    known();
    expect((await post("/v1/messages", mcpRpc, { "content-length": mcpRpc.length })).blocked).toBe(true);
    expect(got.length).toBe(0);
  });

  test("fetch：未知主机的 Blob/流/认不出的体放行（字节不变），LLM 形状遮挡；已知主机认不出的拒绝", async () => {
    unknown();
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/channels/1/messages`, { method: "POST", body: chat });
    await fetch(`${base}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: mcpRpc.toString() });
    await fetch(`${base}/v1/messages`, { method: "POST", body: new Blob(["not json 张伟"]) });
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("raw 张伟")); c.close(); } });
    await fetch(`${base}/v1/responses`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(got.map((g) => g.body.toString())).toEqual([chat.toString(), mcpRpc.toString(), "not json 张伟", "raw 张伟"]);
    expect(maskCalls).toBe(0);
    await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(llmBody()) });
    expect(JSON.parse(got[4]!.body.toString()).messages[0].content).toContain("{{PERSON_aaaaaaaa}}");
    known();
    expect((await fetch(`${base}/messages`, { method: "POST", body: mcpRpc.toString() })).status).toBe(422);
    expect(got.length).toBe(5);
  });

  describe("不发出时的失败方式（返工第 2 轮 · 不可重试）", () => {
    test("fetch：不拒绝，返回 422 + x-should-retry:false + JSON 错误体；文本固定、不含路径/数字/可重试关键词；有提示；服务器 0 条", async () => {
      const r = await fetch(`${httpOrigin()}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "zstd" }, body: new Uint8Array([1, 2, 3]) });
      expect(r.status).toBe(422);
      expect(r.headers.get("x-should-retry")).toBe("false");
      const body = await r.json();
      expect(body).toEqual({ type: "error", error: { type: "invalid_request_error", code: "pii_guard_blocked", message: BLOCKED_MESSAGE } });
      // 文本不能被 omp 当成瞬时错误（它按这些词/状态码判重试）
      expect(BLOCKED_MESSAGE).toMatch(/^[\x20-\x7e]+$/);
      expect(BLOCKED_MESSAGE).not.toMatch(/time(?:d)? ?out|connection|network|server error|internal error|unavailable|overloaded|rate.?limit|fetch failed|\b(?:4\d\d|5\d\d)\b|[\\/]/i);
      expect(got.length).toBe(0);
      expect(failures.length).toBe(1);
      // 模型不可用（遮挡失败）同样
      failMask = true;
      const r2 = await fetch(`${httpOrigin()}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(llmBody()) });
      expect(r2.status).toBe(422);
      expect(r2.headers.get("x-should-retry")).toBe("false");
      expect(got.length).toBe(0);
    });

    test("ClientRequest：不 destroy 成连接错误，向调用方产出合成 422 响应（x-should-retry:false、固定 JSON 错误体），请求不发出", async () => {
      failMask = true;
      const raw = Buffer.from(JSON.stringify(llmBody()));
      const r = await post("/v1/messages", raw, { "content-length": raw.length });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(422);
      expect(r.headers?.["x-should-retry"]).toBe("false");
      expect(r.headers?.["content-type"]).toBe("application/json");
      expect(Number(r.headers?.["content-length"])).toBe(Buffer.byteLength(r.body!));
      expect(JSON.parse(r.body!)).toEqual({ type: "error", error: { type: "invalid_request_error", code: "pii_guard_blocked", message: BLOCKED_MESSAGE } });
      expect(got.length).toBe(0);
      expect(failures.length).toBe(1);
    });

    test("ClientRequest：合成响应是完整的 IncomingMessage（statusCode/statusMessage/rawHeaders/complete、req.res），响应结束后请求被销毁且不再冒出 error", async () => {
      failMask = true;
      const raw = Buffer.from(JSON.stringify(llmBody()));
      const events: string[] = [];
      const info = await new Promise<Record<string, unknown>>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST" }, (res) => {
          res.setEncoding("utf8");
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            events.push("res.end");
            const snapshot = { statusCode: res.statusCode, statusMessage: res.statusMessage, rawHeaders: res.rawHeaders, complete: res.complete, sameRes: req.res === res, text };
            req.on("close", () => {
              events.push("req.close");
              resolve(snapshot);
            });
          });
        });
        req.on("error", (e) => events.push(`req.error ${e.message}`));
        req.end(raw);
      });
      expect(info.statusCode).toBe(422);
      expect(info.statusMessage).toBe("pii-guard blocked");
      expect(info.rawHeaders).toEqual(["content-type", "application/json", "content-length", String(Buffer.byteLength(info.text as string)), "x-should-retry", "false"]);
      expect(info.complete).toBe(true);
      expect(info.sameRes).toBe(true);
      expect(events).toEqual(["res.end", "req.close"]); // 没有 error 事件
      expect(got.length).toBe(0);
    });

    test("ClientRequest：没有 response 监听者时合成响应被丢弃（不挂起、不抛错），请求关闭", async () => {
      failMask = true;
      const raw = Buffer.from(JSON.stringify(llmBody()));
      const events: string[] = [];
      await new Promise<void>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST" });
        req.on("error", (e) => events.push(`error ${e.message}`));
        req.on("close", () => {
          events.push("close");
          resolve();
        });
        req.end(raw);
      });
      expect(events).toEqual(["close"]);
      expect(got.length).toBe(0);
    });
  });

  describe("WebSocket 帧", () => {
    const send = async (url: string, frames: (string | Uint8Array)[]) => {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const w = new WebSocket(url);
        w.onopen = () => resolve(w);
        w.onerror = (e) => reject(e);
      });
      for (const f of frames) ws.send(f);
      await Bun.sleep(150);
      return ws;
    };
    const serve = () => {
      const frames: string[] = [];
      const { promise: closed, resolve } = Promise.withResolvers<void>();
      const s = Bun.serve({
        port: 0,
        fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
        websocket: { message: (_w, m) => void frames.push(String(m)), close: () => resolve() },
      });
      const url = `ws://127.0.0.1:${s.port}/backend-api/codex/responses`;
      if (knownMode) addLlmOrigin(url);
      return { url, frames, closed, stop: () => s.stop(true) };
    };
    const create = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "response.create", model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "张伟" }] }], ...extra });

    test("maskFrame：response.create 遮挡；控制帧（字符串值只在 type/id/event_id/response_id/item_id/previous_response_id 键下）放行；其他不发出", async () => {
      const enc = (o: unknown) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
      const masked = await maskFrame(deps, enc(create()), true);
      expect(masked && JSON.parse(Buffer.from(masked).toString()).input[0].content[0].text).toBe("{{PERSON_aaaaaaaa}}");
      for (const ok of [
        { type: "response.cancel", response_id: "r" },
        { type: "conversation.item.delete", item_id: "i", event_id: "e" },
        { type: "x", previous_response_id: "p", n: 1, b: false, z: null, nested: { id: "q" }, arr: [1, 2] },
      ]) expect(await maskFrame(deps, enc(ok), true)).toBeUndefined();
      for (const bad of [
        { type: "x", input: "张伟" },
        { type: "x", nested: { text: "张伟" } },
        { type: "x", arr: ["张伟"] },
        { type: "x", metadata: { id: "张伟", note: "n" } },
        { model: "m", input: [{ type: "message", role: "user", content: "张伟" }] }, // 没有 type 的 LLM 形状帧：不是 response.create
      ]) await expect(maskFrame(deps, enc(bad), true)).rejects.toThrow();
      await expect(maskFrame(deps, enc("ping"), true)).rejects.toThrow();
      await expect(maskFrame(deps, enc("[1]"), true)).rejects.toThrow();
      // 没有（字符串）type 的帧：包括出口处理器失败后 omp 发出的空壳 {}
      for (const noType of [{}, { n: 1 }, { type: 5 }, { type: null, response_id: "r" }]) await expect(maskFrame(deps, enc(noType), true)).rejects.toThrow("type");
      expect(await maskFrame(deps, enc({}), false)).toBeUndefined(); // 未知来源：放行
    });

    test("maskFrame：未知主机（非 strict）——LLM 形状遮挡，其余（非 JSON、认不出、内容字符串）放行", async () => {
      const enc = (o: unknown) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
      const masked = await maskFrame(deps, enc(create()), false);
      expect(masked).toBeDefined();
      expect(await maskFrame(deps, enc("ping"), false)).toBeUndefined();
      expect(await maskFrame(deps, enc({ type: "x", input: "张伟" }), false)).toBeUndefined();
      expect(await maskFrame(deps, new Uint8Array([0xff, 0xfe]), false)).toBeUndefined();
    });

    test("连接：已知主机上 response.create 遮挡；带内容字符串的非 create 帧不发出并关闭", async () => {
      known();
      const s = serve();
      const ws = await send(s.url, [create(), '{"type":"response.cancel","response_id":"r1"}']);
      expect(s.frames.length).toBe(2);
      expect(JSON.parse(s.frames[0]!).input[0].content[0].text).toBe("{{PERSON_aaaaaaaa}}");
      expect(s.frames[1]).toBe('{"type":"response.cancel","response_id":"r1"}');
      ws.send('{"type":"x","text":"张伟"}');
      await Promise.race([s.closed, Bun.sleep(1000)]);
      expect(s.frames.length).toBe(2);
      expect(failures.some((f) => f.includes("WebSocket"))).toBe(true);
      s.stop();
    });

    test("连接：被阻止时，客户端先收到一帧服务端 error 事件（code=pii_guard_blocked、不可重试），再以 1000 正常关闭，之后的帧都不发出", async () => {
      known();
      const s = serve();
      const received: string[] = [];
      const closeCodes: number[] = [];
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const w = new WebSocket(s.url);
        w.onmessage = (m) => received.push(String(m.data));
        w.onclose = (c) => closeCodes.push(c.code);
        w.onopen = () => resolve(w);
        w.onerror = (e) => reject(e);
      });
      failMask = true;
      ws.send(create());
      ws.send(create());
      await Promise.race([s.closed, Bun.sleep(1000)]);
      await Bun.sleep(50);
      expect(s.frames.length).toBe(0);
      expect(received.length).toBe(1);
      expect(JSON.parse(received[0]!)).toEqual({ type: "error", status: 422, error: { type: "invalid_request_error", code: "pii_guard_blocked", message: BLOCKED_MESSAGE } });
      expect(closeCodes).toEqual([1000]);
      expect(failures.length).toBe(1);
      s.stop();
    });

    test("连接：未知主机上 ping、认不出的帧放行，LLM 形状遮挡", async () => {
      unknown();
      const s = serve();
      const ws = await send(s.url, ["ping", '{"type":"x","text":"张伟"}', create()]);
      expect(s.frames.length).toBe(3);
      expect(s.frames[0]).toBe("ping");
      expect(s.frames[1]).toBe('{"type":"x","text":"张伟"}');
      expect(JSON.parse(s.frames[2]!).input[0].content[0].text).toBe("{{PERSON_aaaaaaaa}}");
      ws.close();
      s.stop();
    });
  });
});
