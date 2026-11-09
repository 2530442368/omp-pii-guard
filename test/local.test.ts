import { describe, expect, test } from "bun:test";
import { LocalLiterals } from "../src/local.ts";

const D = "$".repeat(2);
const dollar = (inner: string) => `${D}${inner}${D}`;
const nested = (n: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < n; i++) v = { x: v };
  return v;
};

describe("LocalLiterals：本地会话与系统提示里字面出现的严格格式 $$…$$", () => {
  test("消息、工具结果、自定义消息、摘要、嵌套对象与数组里的都收；外形不符的不收；完整", () => {
    const a = dollar("AAAA11112222");
    const b = dollar("GITHUBTOKEN_BBBB11112222:L");
    const c = dollar("CCCC11112222:U");
    const d = dollar("DDDD11112222");
    const bad = [dollar("short"), dollar("lowercase1234"), dollar("AAAA1111222:L"), `${D}AAAA11112222`];
    const l = new LocalLiterals();
    const got = l.collect([
      { type: "message", message: { role: "user", content: `x ${a} y` } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: b }] } },
      { type: "custom_message", content: { deep: [[c]] } },
      { type: "compaction", summary: bad.join(" ") },
      null,
      `字符串条目也扫 ${d}`,
    ]);
    expect([...got.literals].sort()).toEqual([a, b, c, d].sort());
    expect(got.complete).toBe(true);
  });

  test("系统提示也收；系统提示换了就重新扫", () => {
    const a = dollar("AAAA11112222");
    const b = dollar("BBBB11112222");
    const l = new LocalLiterals();
    expect([...l.collect([], `提示 ${a}`).literals]).toEqual([a]);
    expect([...l.collect([], `提示 ${b}`).literals]).toEqual([b]);
    expect(l.collect([], undefined)).toEqual({ literals: new Set(), complete: true });
  });

  test("二进制与日期不是文本，不影响完整性；同一条目重复收集结果一致", () => {
    const a = dollar("AAAA11112222");
    const l = new LocalLiterals();
    const entry = { bin: new TextEncoder().encode(a), ab: new ArrayBuffer(8), when: new Date(0), n: 5, flag: true, none: null, ok: { s: a } };
    for (let i = 0; i < 2; i++) {
      const got = l.collect([entry]);
      expect([...got.literals]).toEqual([a]); // 只有 ok.s 里的那份
      expect(got.complete).toBe(true);
    }
  });

  test("返工第 3 轮：超过深度上限的嵌套 → 不完整（没扫到的不算没有）；上限内的仍完整且收到", () => {
    const a = dollar("AAAA11112222");
    const l = new LocalLiterals();
    const deep = l.collect([{ args: nested(20, a) }]);
    expect(deep.complete).toBe(false);
    expect(deep.literals.size).toBe(0);
    const shallow = l.collect([{ args: nested(5, a) }]);
    expect(shallow.complete).toBe(true);
    expect([...shallow.literals]).toEqual([a]);
  });

  test("返工第 3 轮：节点数触顶、读不了的内容（Map、Set、类实例）→ 不完整；已收到的部分仍返回", () => {
    const a = dollar("AAAA11112222");
    const l = new LocalLiterals();
    const wide = l.collect([{ first: a, many: new Array(250_000).fill(1) }]);
    expect(wide.complete).toBe(false);
    class Box {
      constructor(readonly s: string) {}
    }
    for (const unreadable of [new Map([["k", a]]), new Set([a]), new Box(a)]) {
      const got = l.collect([{ ok: a, unreadable }]);
      expect(got.complete).toBe(false);
      expect([...got.literals]).toEqual([a]);
    }
  });

  test("返工第 3 轮：不完整的标记随条目缓存——同一条目第二次收集仍报不完整，不会被当成完整", () => {
    const a = dollar("AAAA11112222");
    const l = new LocalLiterals();
    const entry = { args: nested(20, a) };
    expect(l.collect([entry]).complete).toBe(false);
    expect(l.collect([entry]).complete).toBe(false);
    expect(l.collect([entry, { type: "message", message: { content: "ok" } }]).complete).toBe(false);
    expect(l.collect([{ type: "message", message: { content: "ok" } }]).complete).toBe(true);
  });
});
