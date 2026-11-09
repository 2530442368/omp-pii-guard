// 网络层兜底：包装 globalThis.fetch、globalThis.WebSocket 与 http.ClientRequest.prototype.write/end，
// 覆盖不经 before_provider_request 的直连 LLM 请求（标题直连、judge、本地/远端压缩……）。
//
// 只处理发往“LLM 推理端点”的请求体：路径（不含查询串）是 /messages、/messages/count_tokens、/responses、
// /responses/compact、/chat/completions、/completions（含 codex 的 ws），且（来源是已知 LLM 服务，或体为 LLM 形状）。
// 其他请求（同主机的 oauth、models 列表；未知主机上的 MCP SSE `/messages`、聊天软件 API 等非 LLM 形状的 JSON）
// 字节不变，不解码、不重编码。
// 已知 LLM 服务按 origin（协议 + 主机 + 有效端口；ws/wss 并入 http/https，默认端口 80/443）判定，来源 =
// 内置默认 + omp 模型注册表 + bpr 里见到的 baseUrl。已知服务的推理端点上，体必须能遮挡：Blob、流完整读取后处理；
// 无法解码、无法解析、认不出格式的体一律不发出。
// 未知来源的推理路径：认不出、解析不了的体原样放行；LLM 形状的体照常遮挡（遮挡失败仍不发出）。
//
// 不发出时的失败方式要让 omp 不重试（omp 18.18.1 把连接类错误——fetch 拒绝被 SDK 包成 "Connection error."、
// WebSocket 关闭——当成可重试，会重试约 10 次、-p 150 s 以上不退出）：
//   - fetch：不拒绝，返回合成的 HTTP 422 响应（头 x-should-retry: false，JSON 错误体）。422 不在 omp/SDK 的重试集合里
//     （重试的是 408、409、429、5xx 与连接/超时类消息），也不触发 400/413 才有的 ~/.omp/logs/http-400-requests/ 请求转储；
//   - WebSocket：先向连接的消息处理器投递一帧服务端 error 事件（code=pii_guard_blocked，codex 提供方把它转成
//     retryable=false 的 CodexProviderStreamError），再以 1000 正常关闭；只关连接会被当成传输故障重试；
//   - ClientRequest：不 destroy 成连接错误（Anthropic SDK 会把它包成 APIConnectionError 重试），而是向调用方产出合成的
//     HTTP 422 响应（IncomingMessage，头 x-should-retry: false，同 fetch 的 JSON 错误体），请求本身不发出；
// 错误文本是固定的 ASCII 句子，不含路径、数字、也不含 timeout/connection/server error 之类会被 omp 当成瞬时错误的词；
// 具体原因只在界面提示里（deps.fail）。
// 包装只装一次（globalThis 单例）；处理函数读 state.deps，所以子代理会话里工厂重跑不会重复包装。
// 这里直接给全局 fetch / WebSocket / ClientRequest 打补丁，类型只能放宽成 any（补丁边界，不外泄）。

import * as http from "node:http";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { detectFormat, type Format } from "./payload.ts";

export interface TransportDeps {
  /** 当前是否启用（/pii off、OMP_PII_GUARD=off）。 */
  enabled(): boolean;
  /** 遮挡请求体（就地），返回改动的叶子数；抛错 → 请求不发出。网络层自带 180 s 上限由实现负责。 */
  maskBody(format: Format, body: unknown): Promise<number>;
  /** 向用户说明失败原因（已含关闭方法）。 */
  fail(where: string, err: unknown): void;
}

export interface TransportState {
  deps: TransportDeps | undefined;
  /** 已知 LLM 服务的 origin（见 originOf）。 */
  origins: Set<string>;
  installedAt: number;
}

const KEY = Symbol.for("omp-pii-guard.transport");
const MARK = Symbol.for("omp-pii-guard.wrapped");
const G = globalThis as unknown as Record<string | symbol, any>;

/** 内置的已知 LLM 服务（默认 https:443）；运行时再加 omp 模型注册表与 bpr 里见到的 baseUrl 的 origin（addLlmOrigin）。 */
export const DEFAULT_LLM_ORIGINS: readonly string[] = ["https://api.anthropic.com", "https://api.openai.com", "https://chatgpt.com"];

/** LLM 推理端点的路径（不含查询串）。 */
const INFERENCE_PATH = /\/(?:messages(?:\/count_tokens)?|responses(?:\/compact)?|chat\/completions|completions)\/?$/;

/** 路径（可带查询串）是推理端点。 */
export const isInferencePath = (pathname: string | undefined): boolean => INFERENCE_PATH.test((pathname ?? "").split("?")[0]!);

/**
 * URL → origin 字符串 `协议//小写主机:有效端口`；ws→http、wss→https；不是 http(s)/ws(s) 或解析失败 → ""。
 */
export function originOf(u: string | URL): string {
  try {
    const x = typeof u === "string" ? new URL(u) : u;
    const p = x.protocol === "ws:" ? "http:" : x.protocol === "wss:" ? "https:" : x.protocol;
    if (p !== "http:" && p !== "https:") return "";
    return `${p}//${x.hostname.toLowerCase()}:${x.port || (p === "https:" ? "443" : "80")}`;
  } catch {
    return "";
  }
}

export function getTransport(): TransportState {
  return (G[KEY] ??= { deps: undefined, origins: new Set<string>(DEFAULT_LLM_ORIGINS.map(originOf)), installedAt: 0 } satisfies TransportState) as TransportState;
}

/** 登记一个 baseUrl（或任意 URL）的 origin 为已知 LLM 服务。 */
export function addLlmOrigin(url: string): void {
  const o = originOf(url);
  if (o) getTransport().origins.add(o);
}

/** URL（http/https/ws/wss）的 origin 是已知的 LLM 服务。 */
export const isKnownOrigin = (u: string | URL): boolean => {
  const o = originOf(u);
  return o !== "" && getTransport().origins.has(o);
};

/** 不发出时给调用方看的固定文本（见文件头注释）。 */
export const BLOCKED_MESSAGE = "pii-guard: request blocked before sending because it could not be masked. Nothing was sent to the model service.";

/** fetch 用：合成的 422 响应。 */
const BLOCKED_JSON = JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "pii_guard_blocked", message: BLOCKED_MESSAGE } });

/** fetch 用：合成的 422 响应。 */
function blockedResponse(): Response {
  return new Response(BLOCKED_JSON, {
    status: 422,
    statusText: "pii-guard blocked",
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
}

/**
 * ClientRequest 用：向调用方产出合成的 422 响应（'response' 事件），请求本身不发出（end 没调用过原实现）。
 * 响应读完（或被丢弃）后销毁请求，释放可能已建立的连接；此时请求已有完整响应，不会再冒出连接错误。
 */
function respondBlocked(req: any): void {
  if (req.destroyed) return;
  const res = new http.IncomingMessage(new net.Socket());
  const payload = Buffer.from(BLOCKED_JSON);
  const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(payload.length), "x-should-retry": "false" };
  res.statusCode = 422;
  res.statusMessage = "pii-guard blocked";
  res.httpVersion = "1.1";
  res.httpVersionMajor = 1;
  res.httpVersionMinor = 1;
  res.headers = headers;
  res.rawHeaders = Object.entries(headers).flat();
  res.complete = true;
  res.push(payload);
  res.push(null);
  req.res = res;
  res.once("close", () => req.destroy());
  if (req.emit("response", res) === false) res.resume(); // 没人要响应：丢弃，让它走到 close
}

/** WebSocket 用：投递给连接消息处理器的服务端 error 事件。 */
const BLOCKED_FRAME = JSON.stringify({ type: "error", status: 422, error: { type: "invalid_request_error", code: "pii_guard_blocked", message: BLOCKED_MESSAGE } });

// ---- 编码 ------------------------------------------------------------------------------------

export class UnsupportedEncoding extends Error {
  constructor(enc: string) {
    super(`请求体使用了不支持的 content-encoding（${enc}），无法遮挡`);
    this.name = "UnsupportedEncoding";
  }
}

function decode(buf: Uint8Array, encoding: string): Uint8Array {
  switch (encoding) {
    case "":
    case "identity":
      return buf;
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(buf);
    case "deflate":
      return zlib.inflateSync(buf);
    case "br":
      return zlib.brotliDecompressSync(buf);
    default:
      throw new UnsupportedEncoding(encoding);
  }
}

function encode(buf: Uint8Array, encoding: string): Uint8Array {
  switch (encoding) {
    case "":
    case "identity":
      return buf;
    case "gzip":
    case "x-gzip":
      return zlib.gzipSync(buf);
    case "deflate":
      return zlib.deflateSync(buf);
    case "br":
      return zlib.brotliCompressSync(buf);
    default:
      throw new UnsupportedEncoding(encoding);
  }
}

export class UnrecognizedBody extends Error {
  constructor(why: string) {
    super(`发往 LLM 推理端点的请求体无法遮挡（${why}）`);
    this.name = "UnrecognizedBody";
  }
}

/**
 * 处理一个发往推理端点的 HTTP 请求体（调用方已确认路径）：遮挡并按原编码重新编码，返回新字节；没有改动返回 undefined
 * （调用方原样发出）。strict（已知 LLM 主机）：无法解码、无法解析、认不出格式 → 抛错（请求不发出）；
 * 非 strict（未知主机）：这些情况原样放行，只有认出是 LLM 形状的体才遮挡。遮挡本身失败一律抛错。
 */
export async function maskBytes(
  deps: TransportDeps,
  buf: Uint8Array,
  encodingHeader: string,
  pathname: string | undefined,
  strict: boolean,
): Promise<Uint8Array | undefined> {
  const unusable = (why: string): undefined => {
    if (strict) throw new UnrecognizedBody(why);
    return undefined;
  };
  const encoding = encodingHeader.trim().toLowerCase();
  let plain: Uint8Array;
  try {
    plain = decode(buf, encoding);
  } catch (e) {
    if (strict) throw e; // 不支持的编码、坏压缩体
    return undefined;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return unusable("不是 UTF-8 文本");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return unusable("不是 JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return unusable("不是 JSON 对象");
  const format = detectFormat(pathname, body);
  if (format === undefined) return unusable("认不出请求格式");
  const changed = await deps.maskBody(format, body);
  if (changed === 0) return undefined;
  return encode(new TextEncoder().encode(JSON.stringify(body)), encoding);
}

/** WebSocket 控制帧里允许出现字符串值的键（标识与事件类型，没有承载内容）。 */
const CONTROL_KEYS = new Set(["type", "id", "event_id", "response_id", "item_id", "previous_response_id"]);

/** 所有字符串值都在 CONTROL_KEYS 的键下（数组元素沿用数组所在的键）。 */
function onlyControlStrings(v: unknown, key: string | undefined): boolean {
  if (typeof v === "string") return key !== undefined && CONTROL_KEYS.has(key);
  if (Array.isArray(v)) return v.every((x) => onlyControlStrings(x, key));
  if (v !== null && typeof v === "object") return Object.entries(v).every(([k, x]) => onlyControlStrings(x, k));
  return true;
}

/**
 * 处理一个 WebSocket 帧（推理端点的连接）。type 为 response.create 的走遮挡（认不出格式 → strict 下抛错）；
 * 其他帧：strict 下只有所有字符串值都在 CONTROL_KEYS 的键下才放行，否则抛错；非 strict 下认出是 LLM 形状才遮挡，其余放行。
 */
export async function maskFrame(deps: TransportDeps, buf: Uint8Array, strict: boolean): Promise<Uint8Array | undefined> {
  const unusable = (why: string): undefined => {
    if (strict) throw new UnrecognizedBody(why);
    return undefined;
  };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    return unusable("帧不是 UTF-8 的 JSON 文本");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return unusable("帧不是 JSON 对象");
  const format = detectFormat(undefined, body);
  const create = "type" in body && body.type === "response.create";
  if (create || (!strict && format !== undefined)) {
    if (format === undefined) return unusable("认不出 response.create 帧的格式");
    const changed = await deps.maskBody(format, body);
    return changed === 0 ? undefined : new TextEncoder().encode(JSON.stringify(body));
  }
  // 控制帧必有字符串 type（空对象 {} 是出口处理器失败后 omp 发出的空壳，不放行）
  if (strict && (!("type" in body) || typeof body.type !== "string")) throw new UnrecognizedBody("帧没有 type，不是 response.create 也不是控制帧");
  if (strict && !onlyControlStrings(body, undefined)) throw new UnrecognizedBody("帧带有内容字符串，不是 response.create 也不是控制帧");
  return undefined;
}

// ---- fetch -----------------------------------------------------------------------------------

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** init.body 是只能读一次的流。 */
const isStream = (b: any): boolean => b != null && (typeof b.getReader === "function" || typeof b[Symbol.asyncIterator] === "function");

/**
 * 返回要实际发出的 [input, init]；undefined = 原样发出。
 * 只处理推理端点：先按 URL 与方法判断（不碰请求体），再合成实际生效的 Request（new Request(input, init) 语义，
 * 头、方法、体以合成结果为准）读出体字节。
 */
async function prepareFetch(deps: TransportDeps, input: any, init: any): Promise<[any, any] | undefined> {
  const isReq = typeof Request !== "undefined" && input instanceof Request;
  const method = String(init?.method ?? (isReq ? input.method : "GET")).toUpperCase();
  if (!BODY_METHODS.has(method)) return undefined;
  let url: URL;
  try {
    url = new URL(isReq ? input.url : String(input?.href ?? input));
  } catch {
    return undefined;
  }
  if (!isInferencePath(url.pathname)) return undefined;
  const strict = isKnownOrigin(url);
  // 合成实际生效的请求：Request 输入先 clone（不消耗调用方的体）
  let req: Request;
  try {
    req = new Request(isReq ? input.clone() : input, init);
  } catch (e) {
    if (strict) throw e;
    return undefined; // 未知主机：合成不了就原样交给原生 fetch（它自己会报同样的错）
  }
  if (req.body === null) return undefined;
  const bytes = new Uint8Array(await req.clone().arrayBuffer());
  const encoding = req.headers.get("content-encoding") ?? "";
  const out = await maskBytes(deps, bytes, encoding, url.pathname, strict);
  if (!out) {
    // init.body 是流时它已被合成的 Request 接管，只能发合成的请求
    return isStream(init?.body) ? [req, undefined] : undefined;
  }
  const enc = encoding.trim().toLowerCase();
  const newBody: string | Uint8Array = typeof init?.body === "string" && (enc === "" || enc === "identity") ? new TextDecoder().decode(out) : out;
  const headers = new Headers(req.headers);
  if (headers.has("content-length")) headers.set("content-length", String(out.length));
  return [input, { ...init, body: newBody, headers }];
}

function installFetch(): void {
  const orig = G.fetch as ((...a: any[]) => Promise<Response>) & { [MARK]?: boolean };
  if (typeof orig !== "function" || orig[MARK]) return;
  const wrapped = function piiGuardFetch(this: unknown, input: any, init?: any): Promise<Response> {
    const deps = getTransport().deps;
    if (!deps || !deps.enabled()) return Reflect.apply(orig, this, [input, init]);
    return (async () => {
      let prepared: [any, any] | undefined;
      try {
        prepared = await prepareFetch(deps, input, init);
      } catch (e) {
        deps.fail("fetch", e);
        return blockedResponse();
      }
      return Reflect.apply(orig, this, prepared ?? (init === undefined ? [input] : [input, init]));
    })();
  };
  for (const k of Object.getOwnPropertyNames(orig)) {
    if (k === "length" || k === "name" || k === "prototype" || k in wrapped) continue;
    const d = Object.getOwnPropertyDescriptor(orig, k);
    if (d) Object.defineProperty(wrapped, k, d);
  }
  (wrapped as any)[MARK] = true;
  G.fetch = wrapped;
}

// ---- WebSocket -------------------------------------------------------------------------------

function installWebSocket(): void {
  const Orig = G.WebSocket;
  if (typeof Orig !== "function" || Orig[MARK]) return;
  const CHAIN = Symbol("pii-guard.chain");
  class PiiGuardWebSocket extends Orig {
    [CHAIN]: Promise<void> | undefined;
    dead = false;

    send(data: unknown): void {
      const deps = getTransport().deps;
      let inference = false;
      let strict = false;
      try {
        const u = new URL(String(this.url));
        inference = isInferencePath(u.pathname);
        strict = isKnownOrigin(u);
      } catch {}
      // 非推理端点的连接，或已关闭遮挡：同步原样发出（行为同原生）
      if (!deps || !deps.enabled() || !inference) return super.send(data as string);
      const prev = this[CHAIN] ?? Promise.resolve();
      const next: Promise<void> = prev.then(async () => {
        if (this.dead) return;
        try {
          let frame: unknown = data;
          // 文本帧与二进制帧（ArrayBuffer、视图、Blob）都按 UTF-8 解码处理；没有改动时原样发出
          let bytes: Uint8Array;
          if (typeof data === "string") bytes = new TextEncoder().encode(data);
          else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          else if (typeof Blob !== "undefined" && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
          else if (strict) throw new UnrecognizedBody("不支持的 WebSocket 帧类型");
          else return super.send(data as string);
          const out = await maskFrame(deps, bytes, strict);
          if (out) frame = typeof data === "string" ? new TextDecoder().decode(out) : out;
          super.send(frame as string);
        } catch (e) {
          this.dead = true;
          deps.fail("WebSocket", e);
          try {
            // 先给调用方一个明确的、不可重试的错误事件，再正常关闭（只关连接会被当成传输故障重试）
            this.dispatchEvent(new MessageEvent("message", { data: BLOCKED_FRAME }));
          } catch {}
          try {
            this.close(1000, "pii-guard: blocked");
          } catch {}
        }
      });
      this[CHAIN] = next;
      next.then(() => {
        if (this[CHAIN] === next) this[CHAIN] = undefined;
      });
    }
  }
  (PiiGuardWebSocket as any)[MARK] = true;
  G.WebSocket = PiiGuardWebSocket;
}

// ---- http.ClientRequest ----------------------------------------------------------------------

interface CRState {
  buffering: boolean;
  strict: boolean;
  chunks: Buffer[];
  ended: boolean;
}
const CR_STATE = Symbol("pii-guard.cr");

/** ClientRequest 的目标 URL（协议 + Host 头或 host；Host 头带端口时按它）。 */
function crUrl(req: any): string {
  const proto = typeof req.protocol === "string" && req.protocol ? req.protocol : "http:";
  const host = String((typeof req.getHeader === "function" ? req.getHeader("host") : undefined) ?? req.host ?? "");
  return `${proto}//${host}/`;
}

function installClientRequest(): void {
  const proto = http.ClientRequest.prototype as any;
  if (proto.write?.[MARK] && proto.end?.[MARK]) return;
  const origWrite = proto.write as (...a: any[]) => boolean;
  const origEnd = proto.end as (...a: any[]) => unknown;

  const stateOf = (req: any): CRState => {
    let st: CRState | undefined = req[CR_STATE];
    if (st) return st;
    const deps = getTransport().deps;
    let buffering = false;
    let strict = false;
    if (deps?.enabled()) {
      const method = String(req.method ?? "").toUpperCase();
      const path = String(req.path ?? "").split("?")[0]!;
      buffering = BODY_METHODS.has(method) && isInferencePath(path);
      strict = isKnownOrigin(crUrl(req));
    }
    st = { buffering, strict, chunks: [], ended: false };
    req[CR_STATE] = st;
    return st;
  };

  const toBuf = (chunk: unknown, enc: unknown): Buffer =>
    typeof chunk === "string" ? Buffer.from(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8") : Buffer.from(chunk as Uint8Array);

  const write = function piiGuardWrite(this: any, chunk: unknown, enc?: unknown, cb?: unknown): boolean {
    const st = stateOf(this);
    if (!st.buffering) return origWrite.apply(this, arguments as unknown as any[]);
    if (chunk !== undefined && chunk !== null) st.chunks.push(toBuf(chunk, enc));
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") queueMicrotask(() => (done as () => void)());
    return true;
  };

  const end = function piiGuardEnd(this: any, chunk?: unknown, enc?: unknown, cb?: unknown): unknown {
    const st = stateOf(this);
    if (!st.buffering) return origEnd.apply(this, arguments as unknown as any[]);
    if (st.ended) return this;
    st.ended = true;
    const done = typeof chunk === "function" ? chunk : typeof enc === "function" ? enc : cb;
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") st.chunks.push(toBuf(chunk, enc));
    const deps = getTransport().deps;
    const raw = Buffer.concat(st.chunks);
    st.chunks = [];
    const finish = (body: Uint8Array): void => {
      if (this.destroyed) return;
      if (typeof this.getHeader === "function" && this.getHeader("content-length") !== undefined) this.setHeader("content-length", String(body.length));
      origEnd.call(this, body, typeof done === "function" ? done : undefined);
    };
    (async () => {
      if (!deps) throw new Error("pii-guard 未初始化");
      if (this.headersSent) throw new Error("请求头已发出，无法在发出前遮挡");
      const out = raw.length === 0 ? undefined : await maskBytes(deps, raw, String(this.getHeader?.("content-encoding") ?? ""), String(this.path ?? "").split("?")[0], st.strict);
      finish(out ?? raw);
    })().catch((e) => {
      deps?.fail("http", e);
      respondBlocked(this);
    });
    return this;
  };

  (write as any)[MARK] = true;
  (end as any)[MARK] = true;
  proto.write = write;
  proto.end = end;
}

/** 安装三处包装（幂等）。 */
export function installTransport(deps: TransportDeps): TransportState {
  const st = getTransport();
  st.deps = deps;
  if (st.installedAt === 0) st.installedAt = Date.now();
  installFetch();
  installWebSocket();
  installClientRequest();
  return st;
}

/** 启动自检：返回不在位的包装（空数组 = 全部在位）。 */
export function transportProblems(): string[] {
  const p: string[] = [];
  if (G.fetch?.[MARK] !== true) p.push("fetch");
  if (typeof G.WebSocket === "function" && G.WebSocket[MARK] !== true) p.push("WebSocket");
  const proto = http.ClientRequest.prototype as any;
  if (proto.write?.[MARK] !== true) p.push("ClientRequest.write");
  if (proto.end?.[MARK] !== true) p.push("ClientRequest.end");
  return p;
}
