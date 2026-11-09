// /pii setup：准备模型文件。只在用户执行该命令时联网，扩展自己从不自动下载。
//
// 每个文件依次尝试：
//   1. 目标目录里已有且大小、sha256 都对的：跳过；
//   2. 本机 magpie 缓存（<缓存>/ 与 <缓存>/int8/）里有且校验通过的：复制；
//   3. 从 Hugging Face 的固定修订 URL 下载。
// 下载与复制都先写同目录的临时文件（独占创建 wx、权限 0600，不继承来源权限），校验大小与 sha256 通过后才设为 0644 并原子 rename 到位
// （最终文件对组/其他用户不可写）；失败删除临时文件，
// 已有的正确文件不会被替换。下载限制最大字节数（不超过期望大小）、整体超时；允许 HTTPS 重定向（Hugging Face 会转到 CDN），
// 不允许降级到 http。期望的大小与 sha256 来自 guard.ts 的 MODEL_FILES（scripts/install.sh 保留同值，测试断言一致）。

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MODEL_FILES, modelUrl } from "./guard.ts";

export type ModelFile = (typeof MODEL_FILES)[number];

/** magpie 的模型缓存目录（install.sh 与 /pii setup 共用的默认来源；PII_GUARD_MODEL_SRC 覆盖）。 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PII_GUARD_MODEL_SRC || path.join(os.homedir(), ".cache", "magpie", "astrlink-guard", "7216b6a3b897");
}

export interface SetupOptions {
  /** 目标目录（模型目录）。 */
  dir: string;
  /** 本机缓存目录；其下的 int8/ 子目录也认。 */
  cacheDir: string;
  /** 下载用的 fetch（默认全局 fetch；测试注入）。 */
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 文件名 → 下载地址（默认 Hugging Face 固定修订；测试指向本地假服务器）。 */
  urlOf?: (file: string) => string;
  /** 期望的文件清单（默认 guard.ts 的 MODEL_FILES；测试注入小文件）。 */
  files?: readonly ModelFile[];
  /** 每个文件的下载整体超时（毫秒），默认 10 分钟。 */
  timeoutMs?: number;
  /** 进度回调（每个文件开始处理时）。 */
  onFile?: (name: string, how: "ready" | "copy" | "download") => void;
}

export type SetupHow = "已就绪" | "已复制" | "已下载";
export interface SetupResult {
  files: { name: string; how: SetupHow; ms: number }[];
}

const MAX_REDIRECTS = 5;

/** 文件存在且大小、sha256 都对。 */
export async function fileOk(file: string, f: ModelFile): Promise<boolean> {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size !== f.size) return false;
    const h = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
    return h.digest("hex") === f.sha256;
  } catch {
    return false;
  }
}

const tmpName = (dir: string, name: string): string => path.join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);

/** 临时文件一律自己独占创建（wx）、权限 0600：不继承来源文件的权限（来源可能是 0666）。 */
const openTmp = (tmp: string): Promise<fs.promises.FileHandle> => fs.promises.open(tmp, "wx", 0o600);

/** 最终模型文件的权限：所有者可读写，组与其他用户只读（不可写）。校验通过后才设置并 rename 到位。 */
const FINAL_MODE = 0o644;

async function copyVerified(src: string, dest: string, f: ModelFile, dir: string): Promise<void> {
  const tmp = tmpName(dir, f.name);
  let from: fs.promises.FileHandle | undefined;
  let to: fs.promises.FileHandle | undefined;
  try {
    from = await fs.promises.open(src, "r");
    to = await openTmp(tmp);
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let got = 0;
    for (;;) {
      const { bytesRead } = await from.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      // 来源可能在预检之后变长：写入前累计字节将超过期望大小就中止，不让临时文件超过预期
      if (got + bytesRead > f.size) throw new Error(`来源文件超过预期大小 ${f.size} 字节（预检之后被改动？），已中止`);
      got += bytesRead;
      hash.update(buf.subarray(0, bytesRead));
      for (let at = 0; at < bytesRead; ) at += (await to.write(buf, at, bytesRead - at)).bytesWritten;
    }
    await to.chmod(FINAL_MODE);
    await to.close();
    to = undefined;
    if (got !== f.size || hash.digest("hex") !== f.sha256) throw new Error(`复制到 ${dest} 后校验失败`);
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await to?.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true });
    throw e;
  } finally {
    await from?.close().catch(() => {});
  }
}

/** 跟着重定向取得响应（手动处理：每一跳都检查协议，不允许从 https 降级到 http）。 */
async function fetchFollow(url: string, fetchFn: NonNullable<SetupOptions["fetchFn"]>, signal: AbortSignal): Promise<Response> {
  const httpsOnly = new URL(url).protocol === "https:";
  let cur = url;
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(cur, { redirect: "manual", signal, headers: { accept: "application/octet-stream", "accept-encoding": "identity" } });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!loc) throw new Error(`HTTP ${res.status} 重定向没有 Location`);
    if (hop >= MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
    const next = new URL(loc, cur);
    if (next.protocol !== "https:" && httpsOnly) throw new Error(`拒绝降级到非 HTTPS 的重定向：${next.protocol}//${next.host}`);
    if (next.protocol !== "https:" && next.protocol !== "http:") throw new Error(`不支持的重定向协议：${next.protocol}`);
    cur = next.toString();
  }
}

async function download(dest: string, f: ModelFile, o: Required<Pick<SetupOptions, "dir" | "fetchFn" | "urlOf" | "timeoutMs">>): Promise<void> {
  const tmp = tmpName(o.dir, f.name);
  let fh: fs.promises.FileHandle | undefined;
  const signal = AbortSignal.timeout(o.timeoutMs);
  try {
    const res = await fetchFollow(o.urlOf(f.name), o.fetchFn, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error("响应没有内容");
    fh = await openTmp(tmp);
    const hash = createHash("sha256");
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > f.size) {
        await reader.cancel().catch(() => {});
        throw new Error(`下载内容超过预期大小 ${f.size} 字节`);
      }
      hash.update(value);
      for (let at = 0; at < value.byteLength; ) at += (await fh.write(value, at, value.byteLength - at)).bytesWritten;
    }
    await fh.chmod(FINAL_MODE);
    await fh.close();
    fh = undefined;
    if (got !== f.size) throw new Error(`下载大小 ${got} 与预期 ${f.size} 不符`);
    if (hash.digest("hex") !== f.sha256) throw new Error("sha256 不符（下载内容损坏或被替换）");
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await fh?.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true });
    if (signal.aborted) throw new Error(`下载超时（${Math.round(o.timeoutMs / 1000)} 秒）`);
    throw e;
  }
}

/** 准备齐全部模型文件；任一文件失败即抛错（说明是哪个文件、什么原因），其余已就位的文件保留。 */
export async function setupModel(opts: SetupOptions): Promise<SetupResult> {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const urlOf = opts.urlOf ?? modelUrl;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  await fs.promises.mkdir(opts.dir, { recursive: true });
  const result: SetupResult = { files: [] };
  for (const f of opts.files ?? MODEL_FILES) {
    const start = Date.now();
    const dest = path.join(opts.dir, f.name);
    const done = (how: SetupHow): void => void result.files.push({ name: f.name, how, ms: Date.now() - start });
    if (await fileOk(dest, f)) {
      opts.onFile?.(f.name, "ready");
      done("已就绪");
      continue;
    }
    let cached: string | undefined;
    for (const d of [opts.cacheDir, path.join(opts.cacheDir, "int8")]) {
      if (await fileOk(path.join(d, f.name), f)) {
        cached = path.join(d, f.name);
        break;
      }
    }
    try {
      if (cached) {
        opts.onFile?.(f.name, "copy");
        await copyVerified(cached, dest, f, opts.dir);
        done("已复制");
      } else {
        opts.onFile?.(f.name, "download");
        await download(dest, f, { dir: opts.dir, fetchFn, urlOf, timeoutMs });
        done("已下载");
      }
    } catch (e) {
      throw new Error(`${f.name}：${String((e as Error)?.message ?? e)}`);
    }
  }
  return result;
}
