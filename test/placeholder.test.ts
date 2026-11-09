import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ALL_KINDS } from "../src/config.ts";
import { Placeholders, loadKey, noRestoreTool, restorePolicy } from "../src/placeholder.ts";
import type { Kind } from "../src/types.ts";

const kinds = new Set<Kind>(ALL_KINDS);
const cfg = { noRestoreTools: [] as string[], restoreTools: [] as string[] };
const key = (b: number): (() => Buffer) => () => Buffer.alloc(32, b);

describe("占位符", () => {
  test("形如 {{KIND_xxxxxxxx}}，同值同占位符，不同类别不同占位符", () => {
    const p = new Placeholders(key(1));
    const a = p.tag("PERSON", "张伟", kinds);
    expect(a).toMatch(/^\{\{PERSON_[a-z2-7]{8}\}\}$/);
    expect(p.tag("PERSON", "张伟", kinds)).toBe(a);
    expect(p.tag("ADDRESS", "张伟", kinds)).not.toBe(a);
    expect(p.tag("PERSON", "李四", kinds)).not.toBe(a);
  });

  test("不同 key → 不同占位符；同 key 跨实例稳定", () => {
    const a = new Placeholders(key(1)).tag("PHONE", "13812345678", kinds);
    const b = new Placeholders(key(2)).tag("PHONE", "13812345678", kinds);
    const c = new Placeholders(key(1)).tag("PHONE", "13812345678", kinds);
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  test("遮挡 → 还原往返一致", () => {
    const p = new Placeholders(key(3));
    const ph = p.tag("EMAIL", "zhangwei@acme-corp.cn", kinds);
    expect(p.restoreText(`写信给 ${ph}。`)).toBe("写信给 zhangwei@acme-corp.cn。");
    expect(p.restoreText("没有占位符")).toBe("没有占位符");
    expect(p.restoreText("{{EMAIL_aaaaaaaa}} 不认识的保持原样")).toBe("{{EMAIL_aaaaaaaa}} 不认识的保持原样");
  });

  test("值的内容里含 $& 之类不被 replace 当模式", () => {
    const p = new Placeholders(key(3));
    const ph = p.tag("SECRET", "a$&b$1c$$d", kinds);
    expect(p.restoreText(`x ${ph} y`)).toBe("x a$&b$1c$$d y");
  });

  test("restoreDeep：深度还原、不改入参、报告是否有改动", () => {
    const p = new Placeholders(key(4));
    const ph = p.tag("PERSON", "张伟", kinds);
    const input = { path: "/tmp/a.txt", content: `你好 ${ph}`, nested: [{ x: ph }, 3, null, true], n: 1 };
    const snapshot = JSON.stringify(input);
    const r = p.restoreDeep(input);
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ path: "/tmp/a.txt", content: "你好 张伟", nested: [{ x: "张伟" }, 3, null, true], n: 1 });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(p.restoreDeep({ a: "无" }).changed).toBe(false);
  });

  test("restoreDeep 的 skip：URL 叶子不还原", () => {
    const p = new Placeholders(key(4));
    const ph = p.tag("PERSON", "张伟", kinds);
    const pol = restorePolicy("read", { path: "/tmp/x" }, cfg);
    expect(typeof pol).toBe("function");
    const r = p.restoreDeep({ path: `https://example.com/u/${ph}`, other: ph }, pol as (s: string) => boolean);
    expect(r.value).toEqual({ path: `https://example.com/u/${ph}`, other: "张伟" });
  });

  test("不还原清单", () => {
    for (const n of ["web_search", "_web_search", "generate_image", "web_fetch", "fetch", "fetch_url", "browser", "browser_click"]) expect(noRestoreTool(n)).toBe(true);
    for (const n of ["write", "bash", "edit", "read", "task", "eval"]) expect(noRestoreTool(n)).toBe(false);
    expect(noRestoreTool("my_http", ["my_http"])).toBe(true);
    expect(noRestoreTool("mcp_search_x", ["mcp_search*"])).toBe(true);
    expect(noRestoreTool("write", ["mcp_search*"])).toBe(false);
    expect(restorePolicy("web_search", {}, cfg)).toBe("all");
    expect(restorePolicy("write", { path: "/tmp/a.txt" }, cfg)).toBeUndefined();
  });

  test("S-F1：mcp__* 默认不还原，restoreTools 通配放行，noRestoreTools 优先", () => {
    expect(noRestoreTool("mcp__figma_mcp_go_set_text")).toBe(true);
    expect(noRestoreTool("_mcp__dbhub_demo_execute_sql")).toBe(true);
    expect(noRestoreTool("mcp__dbhub_demo_execute_sql", [], ["mcp__dbhub*"])).toBe(false);
    expect(noRestoreTool("mcp__git_status", [], ["mcp__dbhub*"])).toBe(true);
    expect(noRestoreTool("mcp__dbhub_x", ["mcp__dbhub_x"], ["mcp__dbhub*"])).toBe(true);
    expect(restorePolicy("mcp__x_y", { q: "a" }, cfg)).toBe("all");
    expect(restorePolicy("mcp__dbhub_q", { q: "a" }, { noRestoreTools: [], restoreTools: ["mcp__dbhub*"] })).toBeUndefined();
  });

  test("S-F1：按调用目标——xd://<tool> 套用该工具的策略，外部 scheme 不还原，本机 scheme 与路径照常", () => {
    const p = (tool: string, target: string, c = cfg) => restorePolicy(tool, { path: target, content: "x" }, c);
    // write 到 MCP 设备 = 调用外部服务
    expect(p("write", "xd://mcp__figma_mcp_go_set_text")).toBe("all");
    expect(p("write", "xd://mcp__dbhub_demo_execute_sql", { noRestoreTools: [], restoreTools: ["mcp__dbhub*"] })).toBeUndefined();
    expect(p("write", "xd://web_search")).toBe("all");
    expect(p("write", "xd://lsp")).toBeUndefined(); // 本地内置工具
    expect(p("write", "xd://")).toBe("all");
    for (const t of ["ssh://host/~/a", "http://x/y", "https://x/y", "mcp://srv/res", "pr://1", "issue://2", "SSH://h/x"]) expect(p("write", t)).toBe("all");
    for (const t of ["local://plan.md", "agent://abc", "out://1", "artifact://2", "/tmp/a.txt", "relative/a.txt", "C:\\a.txt"]) expect(p("write", t)).toBeUndefined();
    // read：本机 scheme 与路径仍保留“URL 叶子不还原”的判断函数
    expect(typeof restorePolicy("read", { path: "local://x" }, cfg)).toBe("function");
    expect(restorePolicy("read", { path: "ssh://h/x" }, cfg)).toBe("all");
    expect(restorePolicy("write", { uri: "https://x" }, cfg)).toBe("all");
  });

  test("load：从持久化条目恢复；类别取自占位符；坏条目忽略", () => {
    const p = new Placeholders(key(5));
    const ph = p.tag("PERSON", "张伟", kinds);
    const q = new Placeholders(key(9)); // 另一个 key 也能还原已持久化的占位符
    expect(q.load([{ ph, value: "张伟" }, { ph: "bad", value: "x" }, { ph: "{{NOPE_abcdefgh}}", value: "y" }, null as never], kinds, new Set())).toBe(1);
    expect(q.restoreText(`${ph}`)).toBe("张伟");
    expect(q.known.get("张伟")).toBe("PERSON");
  });

  test("known 只含启用的类别、不含允许词", () => {
    const p = new Placeholders(key(5));
    p.tag("PERSON", "张伟", new Set<Kind>(["PERSON"]));
    p.tag("PHONE", "13812345678", new Set<Kind>(["PERSON"]));
    expect([...p.known.keys()]).toEqual(["张伟"]);
    p.rebuildKnown(new Set<Kind>(["PERSON", "PHONE"]), new Set(["张伟"]), 0.8);
    expect([...p.known.keys()]).toEqual(["13812345678"]);
  });

  test("R-P2：已知值带识别分数，按当前阈值过滤；持久化恢复也一样", () => {
    const p = new Placeholders(key(5));
    p.rebuildKnown(kinds, new Set(), 0.8);
    const ph = p.tag("PHONE", "13812345678", kinds, 0.85);
    expect(p.known.has("13812345678")).toBe(true);
    expect(p.scoreOf(ph)).toBe(0.85);
    // 再次遇到同值但不带分数（补遮路径）不改分数
    p.tag("PHONE", "13812345678", kinds);
    expect(p.scoreOf(ph)).toBe(0.85);
    // 阈值调到 0.95：不再补遮；占位符映射仍在（还原照常）
    p.rebuildKnown(kinds, new Set(), 0.95);
    expect(p.known.has("13812345678")).toBe(false);
    expect(p.restoreText(ph)).toBe("13812345678");
    // 更高分数的再次识别会把它放回来（取最高分）
    p.tag("PHONE", "13812345678", kinds, 0.99);
    expect(p.known.has("13812345678")).toBe(true);
    // 恢复：低分条目在高阈值下不进已知值表；旧条目（无分数）按 1 处理
    const q = new Placeholders(key(5));
    q.rebuildKnown(kinds, new Set(), 0.95);
    q.load([{ ph, value: "13812345678", s: 0.85 }], kinds, new Set());
    expect(q.known.size).toBe(0);
    expect(q.restoreText(ph)).toBe("13812345678");
    const r = new Placeholders(key(5));
    r.rebuildKnown(kinds, new Set(), 0.95);
    r.load([{ ph, value: "13812345678" }], kinds, new Set());
    expect(r.known.has("13812345678")).toBe(true);
  });

  test("占位符碰撞时加长而不是覆盖（8 位相同、值不同）", () => {
    const p = new Placeholders(key(6));
    const a = p.tag("PERSON", "甲", kinds);
    // 人为占位：用 a 的名字登记另一个值，模拟碰撞
    p.byPh.set(a, "别的值");
    const b = p.tag("PERSON", "乙", kinds);
    const c = p.tag("PERSON", "丙", kinds);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(p.restoreText(b)).toBe("乙");
  });
});

describe("密钥文件", () => {
  test("首次生成 32 字节、0600；再次读取同一把；长度不对时报错不覆盖", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-key-"));
    const f = path.join(dir, "sub", "key");
    const k1 = loadKey(f);
    expect(k1.length).toBe(32);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(loadKey(f).equals(k1)).toBe(true);
    fs.writeFileSync(f, "short");
    expect(() => loadKey(f)).toThrow(/32 字节/);
    expect(fs.readFileSync(f, "utf8")).toBe("short");
    fs.rmSync(dir, { recursive: true });
  });

  test("已有密钥文件权限被放宽时收回到 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-key-"));
    const f = path.join(dir, "key");
    const k = loadKey(f);
    fs.chmodSync(f, 0o644);
    expect(loadKey(f).equals(k)).toBe(true);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("密钥文件权限（第 1 轮）", () => {
  test("权限不是 0600（0644、0400、0700、0666）一律改回 0600，内容不变", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-key-"));
    const f = path.join(dir, "key");
    const k = loadKey(f);
    for (const mode of [0o644, 0o400, 0o700, 0o666, 0o640]) {
      fs.chmodSync(f, mode);
      expect(loadKey(f).equals(k)).toBe(true);
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(dir, { recursive: true });
  });

  test("EEXIST 分支（另一个进程刚写了密钥）：同样把放宽的权限收回 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-key-"));
    const f = path.join(dir, "key");
    const theirs = Buffer.alloc(32, 9);
    const real = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((p: any, data: any, opts: any) => {
      // 竞争：我们写之前，别的进程已经以 0644 写好了
      real(p, theirs, { mode: 0o644 });
      fs.chmodSync(p, 0o644);
      const e = new Error("exists") as NodeJS.ErrnoException;
      e.code = "EEXIST";
      void data;
      void opts;
      throw e;
    }) as typeof fs.writeFileSync);
    try {
      expect(loadKey(f).equals(theirs)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true });
  });
});
