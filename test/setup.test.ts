// /pii setup 的模型准备：用本地假服务器与小文件验证 跳过 / 复制 / 下载 / 各种失败（A1、A2）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MODEL_FILES, MODEL_REVISION, modelUrl } from "../src/guard.ts";
import { fileOk, setupModel, type ModelFile } from "../src/setup.ts";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const CONTENT: Record<string, Buffer> = {
  "a.bin": Buffer.from("alpha-".repeat(5000)),
  "b.bin": Buffer.from("bravo-".repeat(300)),
  "c.json": Buffer.from('{"tokenizer":"fake"}'),
};
const FILES: ModelFile[] = Object.entries(CONTENT).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) }));

let server: http.Server;
let base = "";
let hits: string[] = [];
let dir = "";
let cache = "";
/** 路由 → 行为覆盖（按路径前缀）。 */
let mode: "ok" | "redirect" | "wrongBytes" | "short" | "long" | "http500" | "stall" = "ok";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    const name = path.basename(req.url!.split("?")[0]!);
    const body = CONTENT[name];
    if (req.url!.startsWith("/cdn/")) {
      res.end(body);
      return;
    }
    if (!body || mode === "http500") {
      res.statusCode = mode === "http500" ? 500 : 404;
      res.end("nope");
    } else if (mode === "redirect") {
      res.statusCode = 302;
      res.setHeader("location", `/cdn/${name}`);
      res.end();
    } else if (mode === "wrongBytes") res.end(Buffer.alloc(body.length, 0x41));
    else if (mode === "short") res.end(body.subarray(0, body.length - 1));
    else if (mode === "long") res.end(Buffer.concat([body, Buffer.from("extra")]));
    else if (mode === "stall") {
      res.write(body.subarray(0, 10)); // 永不结束
    } else res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  hits = [];
  mode = "ok";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-setup-"));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "pii-cache-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

const urlOf = (name: string): string => `${base}/model/${name}`;
const run = (over: Parameters<typeof setupModel>[0] extends infer O ? Partial<O> : never = {}) => setupModel({ dir, cacheDir: cache, files: FILES, urlOf, timeoutMs: 5000, ...over });
const leftovers = (): string[] => fs.readdirSync(dir).filter((n) => !CONTENT[n]);

describe("单一来源：src 与 install.sh 的钉死值一致", () => {
  test("install.sh 的 REV / FILES（名称:大小:sha256）与 guard.ts 的 MODEL_REVISION / MODEL_FILES 相同；下载地址格式", () => {
    const sh = fs.readFileSync(path.join(import.meta.dir, "../scripts/install.sh"), "utf8");
    expect(/^REV="([0-9a-f]{40})"$/m.exec(sh)?.[1]).toBe(MODEL_REVISION);
    const entries = [...sh.matchAll(/^\s*"([^":]+):(\d+):([0-9a-f]{64})"$/gm)].map((m) => ({ name: m[1]!, size: Number(m[2]), sha256: m[3]! }));
    expect(entries).toEqual(MODEL_FILES.map((f) => ({ ...f })));
    expect(sh).toContain('HF="https://huggingface.co/QuantumNous/astrlink-guard/resolve/$REV/int8"');
    expect(modelUrl("tokenizer.json")).toBe(`https://huggingface.co/QuantumNous/astrlink-guard/resolve/${MODEL_REVISION}/int8/tokenizer.json`);
  });
});

describe("setupModel（A1）", () => {
  test("目标目录里已有且校验通过：跳过，不联网", async () => {
    for (const [n, b] of Object.entries(CONTENT)) fs.writeFileSync(path.join(dir, n), b);
    const r = await run();
    expect(r.files.map((f) => f.how)).toEqual(["已就绪", "已就绪", "已就绪"]);
    expect(hits).toEqual([]);
  });

  test("本机缓存里有且校验通过：复制（根目录与 int8/ 子目录都认），不联网，不留临时文件", async () => {
    fs.writeFileSync(path.join(cache, "a.bin"), CONTENT["a.bin"]!);
    fs.mkdirSync(path.join(cache, "int8"));
    fs.writeFileSync(path.join(cache, "int8", "b.bin"), CONTENT["b.bin"]!);
    fs.writeFileSync(path.join(cache, "int8", "c.json"), CONTENT["c.json"]!);
    const r = await run();
    expect(r.files.map((f) => f.how)).toEqual(["已复制", "已复制", "已复制"]);
    expect(hits).toEqual([]);
    for (const f of FILES) expect(await fileOk(path.join(dir, f.name), f)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  test("都没有：从服务器下载并校验（含相对地址的重定向）；混合场景：已有 / 复制 / 下载各一个", async () => {
    mode = "redirect";
    fs.writeFileSync(path.join(dir, "a.bin"), CONTENT["a.bin"]!);
    fs.writeFileSync(path.join(cache, "b.bin"), CONTENT["b.bin"]!);
    const r = await run();
    expect(r.files.map((f) => f.how)).toEqual(["已就绪", "已复制", "已下载"]);
    expect(hits).toEqual(["/model/c.json", "/cdn/c.json"]);
    for (const f of FILES) expect(await fileOk(path.join(dir, f.name), f)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  test("缓存里的文件损坏（sha256 不符）：不复制，改走下载", async () => {
    fs.writeFileSync(path.join(cache, "a.bin"), Buffer.alloc(CONTENT["a.bin"]!.length, 0x42));
    const r = await run();
    expect(r.files[0]!.how).toBe("已下载");
    expect(await fileOk(path.join(dir, "a.bin"), FILES[0]!)).toBe(true);
  });

  test("目标目录里已有但损坏的文件：被下载的正确文件替换", async () => {
    fs.writeFileSync(path.join(dir, "b.bin"), "broken");
    const r = await run();
    expect(r.files[1]!.how).toBe("已下载");
    expect(await fileOk(path.join(dir, "b.bin"), FILES[1]!)).toBe(true);
  });

  test("目标目录不存在：自动创建", async () => {
    const nested = path.join(dir, "x", "y");
    await run({ dir: nested });
    expect(fs.readdirSync(nested).sort()).toEqual(["a.bin", "b.bin", "c.json"]);
  });
});

describe("文件权限（返工 S-P2）", () => {
  /** 记录 setup 创建文件时用的 open 参数（临时文件应是 wx + 0600）。 */
  async function withOpenSpy<T>(fn: () => Promise<T>): Promise<{ result: T; opens: { file: string; flags: unknown; mode: unknown }[] }> {
    const opens: { file: string; flags: unknown; mode: unknown }[] = [];
    const orig = fs.promises.open;
    (fs.promises as any).open = (p: unknown, flags?: unknown, mode?: unknown) => {
      opens.push({ file: path.basename(String(p)), flags, mode });
      return (orig as any).call(fs.promises, p, flags, mode);
    };
    try {
      return { result: await fn(), opens };
    } finally {
      (fs.promises as any).open = orig;
    }
  }
  const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

  test("缓存来源是 0666：复制后的结果文件对组/其他用户不可写；临时文件是 wx 独占创建、0600", async () => {
    for (const [n, b] of Object.entries(CONTENT)) {
      fs.writeFileSync(path.join(cache, n), b);
      fs.chmodSync(path.join(cache, n), 0o666);
    }
    const { opens } = await withOpenSpy(() => run());
    for (const f of FILES) {
      const m = modeOf(path.join(dir, f.name));
      expect(m & 0o022).toBe(0); // 组/其他不可写
      expect(m & 0o600).toBe(0o600); // 所有者可读写
      expect(await fileOk(path.join(dir, f.name), f)).toBe(true);
    }
    const tmps = opens.filter((o) => o.file.endsWith(".tmp"));
    expect(tmps.length).toBe(3);
    for (const t of tmps) {
      expect(t.flags).toBe("wx");
      expect(t.mode).toBe(0o600);
    }
    expect(leftovers()).toEqual([]);
  });

  test("下载：临时文件 wx + 0600，结果文件对组/其他用户不可写；下载过程中临时文件对组/其他不可读写", async () => {
    let midMode = -1;
    const fetchFn = async (_u: string, _i?: RequestInit): Promise<Response> => {
      const body = CONTENT["a.bin"]!;
      let sent = 0;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (sent === 0) {
              c.enqueue(body.subarray(0, 100));
              sent = 100;
              return;
            }
            const tmp = fs.readdirSync(dir).find((n) => n.endsWith(".tmp"));
            if (tmp) midMode = modeOf(path.join(dir, tmp)); // 第二次拉取时，第一块已写入临时文件
            c.enqueue(body.subarray(100));
            c.close();
          },
        }),
      );
    };
    const { opens } = await withOpenSpy(() => run({ fetchFn, files: [FILES[0]!] }));
    expect(midMode).toBe(0o600);
    const tmps = opens.filter((o) => o.file.endsWith(".tmp"));
    expect(tmps.length).toBe(1);
    expect(tmps[0]!.flags).toBe("wx");
    expect(tmps[0]!.mode).toBe(0o600);
    expect(modeOf(path.join(dir, "a.bin")) & 0o022).toBe(0);
    expect(await fileOk(path.join(dir, "a.bin"), FILES[0]!)).toBe(true);
  });

  test("已存在的 0666 旧文件（损坏）被替换后，新文件不再是 0666", async () => {
    fs.writeFileSync(path.join(dir, "a.bin"), "broken");
    fs.chmodSync(path.join(dir, "a.bin"), 0o666);
    await run({ files: [FILES[0]!] });
    expect(modeOf(path.join(dir, "a.bin")) & 0o022).toBe(0);
  });
});

describe("复制时来源变长（返工：写入前检查累计字节）", () => {
  test("来源在大小/哈希预检之后变长：复制中止、临时文件写入量不超过预期、目标目录无残留、已有的正确文件不被替换", async () => {
    // a.bin 已在目标目录且正确；b.bin 只在缓存里，预检通过后被追加了内容
    fs.writeFileSync(path.join(dir, "a.bin"), CONTENT["a.bin"]!);
    const ino = fs.statSync(path.join(dir, "a.bin")).ino;
    const src = path.join(cache, "b.bin");
    fs.writeFileSync(src, CONTENT["b.bin"]!);
    const written: number[] = [];
    const orig = fs.promises.open;
    (fs.promises as any).open = async (p: unknown, flags?: unknown, mode?: unknown) => {
      if (path.resolve(String(p)) === src && flags === "r") fs.appendFileSync(src, "x".repeat(5000)); // 预检（fileOk）已过，复制才打开来源
      const fh = await (orig as any).call(fs.promises, p, flags, mode);
      if (String(p).endsWith(".tmp")) {
        const w = fh.write.bind(fh);
        fh.write = async (buf: Buffer, off: number, len: number, ...rest: unknown[]) => {
          written.push(len);
          return w(buf, off, len, ...rest);
        };
      }
      return fh;
    };
    try {
      await expect(run({ files: [FILES[0]!, FILES[1]!] })).rejects.toThrow(/b\.bin：来源文件超过预期大小/);
    } finally {
      (fs.promises as any).open = orig;
    }
    expect(written.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(FILES[1]!.size); // 没有写出超过预期大小的内容
    expect(fs.readdirSync(dir)).toEqual(["a.bin"]); // 无临时文件、无 b.bin
    expect(fs.statSync(path.join(dir, "a.bin")).ino).toBe(ino);
    expect(await fileOk(path.join(dir, "a.bin"), FILES[0]!)).toBe(true);
    expect(hits).toEqual([]); // 复制失败不改走下载（也没有联网）
  });
});

describe("setupModel 失败（A2）：不留下目标文件、不留临时文件、不替换已有的正确文件、给出原因", () => {
  test("sha256 不符（大小对）", async () => {
    mode = "wrongBytes";
    await expect(run()).rejects.toThrow(/a\.bin：sha256 不符/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("内容比预期短 / 比预期长（超过预期大小即中止）", async () => {
    mode = "short";
    await expect(run()).rejects.toThrow(/a\.bin：下载大小 \d+ 与预期 \d+ 不符/);
    expect(fs.readdirSync(dir)).toEqual([]);
    mode = "long";
    await expect(run()).rejects.toThrow(/a\.bin：下载内容超过预期大小/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("HTTP 错误（404、500）", async () => {
    mode = "http500";
    await expect(run()).rejects.toThrow(/a\.bin：HTTP 500/);
    mode = "ok";
    await expect(run({ urlOf: (n) => `${base}/missing/${n}.nope` })).rejects.toThrow(/HTTP 404/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("超时：整体超时后中止，不留临时文件", async () => {
    mode = "stall";
    await expect(run({ timeoutMs: 400 })).rejects.toThrow(/a\.bin：下载超时/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("从 https 重定向降级到 http：拒绝，且不请求降级后的地址", async () => {
    const seen: string[] = [];
    const fetchFn = async (input: string): Promise<Response> => {
      seen.push(input);
      return new Response(null, { status: 302, headers: { location: "http://evil.example/model.bin" } });
    };
    await expect(run({ fetchFn, urlOf: (n) => `https://huggingface.co/x/${n}` })).rejects.toThrow(/拒绝降级到非 HTTPS/);
    expect(seen).toEqual(["https://huggingface.co/x/a.bin"]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("重定向过多、重定向没有 Location：失败", async () => {
    let n = 0;
    const loop = async (): Promise<Response> => new Response(null, { status: 302, headers: { location: `https://huggingface.co/hop/${++n}` } });
    await expect(run({ fetchFn: loop, urlOf: () => "https://huggingface.co/start" })).rejects.toThrow(/重定向超过 5 次/);
    const noLoc = async (): Promise<Response> => new Response(null, { status: 302 });
    await expect(run({ fetchFn: noLoc, urlOf: () => "https://huggingface.co/start" })).rejects.toThrow(/没有 Location/);
  });

  test("允许 https → https 的重定向（跨主机，如 CDN）", async () => {
    const seen: string[] = [];
    const fetchFn = async (input: string): Promise<Response> => {
      seen.push(input);
      if (input.startsWith("https://huggingface.co/")) return new Response(null, { status: 302, headers: { location: "https://cdn.example/blob/x" } });
      return new Response(CONTENT["a.bin"]!);
    };
    await run({ fetchFn, files: [FILES[0]!], urlOf: (n) => `https://huggingface.co/x/${n}` });
    expect(seen).toEqual(["https://huggingface.co/x/a.bin", "https://cdn.example/blob/x"]);
    expect(await fileOk(path.join(dir, "a.bin"), FILES[0]!)).toBe(true);
  });

  test("某个文件失败：已就位的正确文件保留不动，失败的文件没有残留，报错点名文件", async () => {
    fs.writeFileSync(path.join(dir, "a.bin"), CONTENT["a.bin"]!);
    const before = fs.statSync(path.join(dir, "a.bin")).ino;
    mode = "http500";
    await expect(run()).rejects.toThrow(/b\.bin：HTTP 500/);
    expect(fs.statSync(path.join(dir, "a.bin")).ino).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["a.bin"]);
  });

  test("已有的正确文件在其他文件失败时不会被替换（先校验通过的跳过，不重新下载）", async () => {
    for (const n of ["a.bin", "b.bin"]) fs.writeFileSync(path.join(dir, n), CONTENT[n]!);
    mode = "http500";
    await expect(run()).rejects.toThrow(/c\.json：HTTP 500/);
    expect(hits).toEqual(["/model/c.json"]);
  });

  test("默认下载地址：固定修订的 Hugging Face https URL（不用测试注入时的行为）", async () => {
    const seen: string[] = [];
    const fetchFn = async (input: string): Promise<Response> => {
      seen.push(input);
      return new Response("x", { status: 500 });
    };
    await expect(setupModel({ dir, cacheDir: cache, fetchFn })).rejects.toThrow(/model_int8\.onnx：HTTP 500/);
    expect(seen).toEqual([`https://huggingface.co/QuantumNous/astrlink-guard/resolve/${MODEL_REVISION}/int8/model_int8.onnx`]);
  });
});
