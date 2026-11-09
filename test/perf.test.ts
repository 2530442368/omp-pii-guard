// 性能：knownSpans 在 1 MB 文本 × 1000 个已知值下应小于 200 ms（含第一次建索引）。
// 每次都用新的 Map，避免命中按 Map 缓存的索引。耗时打印到标准输出，供报告引用。

import { describe, expect, test } from "bun:test";
import { knownSpans } from "../src/known.ts";
import { modelSpans } from "../src/filters.ts";
import { opts } from "./helpers.ts";
import type { Kind } from "../src/filters.ts";

const BUDGET_MS = 200;
const SIZE = 1 << 20; // 1 MiB 码元

/** 确定性伪随机，保证每次运行用同样的数据。 */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const MIXED = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function pick(r: () => number, alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out;
}

function knownValues(r: () => number, n: number): Map<string, Kind> {
  const m = new Map<string, Kind>();
  for (let i = 0; m.size < n; i++) {
    switch (i % 4) {
      case 0:
        m.set(pick(r, MIXED, 14) + "9Q", "SECRET");
        break;
      case 1:
        m.set(`${pick(r, LOWER, 6)}.${pick(r, LOWER, 4)}@${pick(r, LOWER, 7)}.com`, "EMAIL");
        break;
      case 2:
        m.set(`1${3 + Math.floor(r() * 6)}${pick(r, "0123456789", 9)}`, "PHONE");
        break;
      default:
        m.set(`${pick(r, LOWER, 5)} ${pick(r, LOWER, 7)}`, "PERSON");
    }
  }
  return m;
}

/** 普通文本：小写词与偶尔的代码行，每 plant 个词插入一个已知值。 */
function prose(r: () => number, values: string[], lineBreaks: boolean): { text: string; planted: number } {
  const parts: string[] = [];
  let len = 0;
  let planted = 0;
  let words = 0;
  while (len < SIZE) {
    let w: string;
    if (words % 40 === 39) {
      w = values[Math.floor(r() * values.length)]!;
      planted++;
    } else {
      w = pick(r, LOWER, 2 + Math.floor(r() * 7));
    }
    const sep = lineBreaks && words % 12 === 11 ? "\n" : " ";
    parts.push(w, sep);
    len += w.length + 1;
    words++;
  }
  return { text: parts.join(""), planted };
}

function time<T>(f: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = f();
  return { ms: performance.now() - t0, value };
}

describe("knownSpans 性能（1 MB × 1000 个已知值）", () => {
  test("普通文本（多行）", () => {
    const r = rng(1);
    const known = knownValues(r, 1000);
    const { text, planted } = prose(r, [...known.keys()], true);
    const { ms, value } = time(() => knownSpans(text, known));
    console.log(`knownSpans 多行 ${text.length} 码元 × ${known.size} 值，命中 ${value.length}/${planted}：${ms.toFixed(1)} ms（含建索引）`);
    expect(value.length).toBe(planted);
    expect(ms).toBeLessThan(BUDGET_MS);
    const again = time(() => knownSpans(text, known));
    console.log(`knownSpans 多行（索引已缓存）：${again.ms.toFixed(1)} ms`);
    expect(again.ms).toBeLessThan(BUDGET_MS);
  });

  test("一整行 1 MB（没有换行），大量命中：行首行尾不能每次从头扫", () => {
    const r = rng(2);
    const known = knownValues(r, 1000);
    const { text, planted } = prose(r, [...known.keys()], false);
    expect(text.includes("\n")).toBe(false);
    const { ms, value } = time(() => knownSpans(text, known));
    console.log(`knownSpans 单行 ${text.length} 码元 × ${known.size} 值，命中 ${value.length}/${planted}：${ms.toFixed(1)} ms`);
    expect(value.length).toBe(planted);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("已知的是“包名”：全小写词值在 import / 清单 / 命令行里很多次出现，每次都要查行", () => {
    const r = rng(3);
    const known = new Map<string, Kind>();
    for (let i = 0; i < 1000; i++) known.set(`${pick(r, LOWER, 6)}-${pick(r, LOWER, 5)}2`, "SECRET");
    const names = [...known.keys()];
    const lines: string[] = [];
    let len = 0;
    let n = 0;
    while (len < SIZE) {
      const v = names[n++ % names.length]!;
      const l = n % 3 === 0 ? `import x from '${v}';\n` : n % 3 === 1 ? `    "${v}": "^1.2.3",\n` : `the secret ${v} is here\n`;
      lines.push(l);
      len += l.length;
    }
    const text = lines.join("");
    const { ms, value } = time(() => knownSpans(text, known));
    console.log(`knownSpans 包名/清单行 ${text.length} 码元 × ${known.size} 值，命中 ${value.length}：${ms.toFixed(1)} ms`);
    expect(value.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("最坏的前缀（线性，上限放宽到 1 s）：文本全是 a，已知值是 30 个 a 加一个 b（每个位置都走 30 步）", () => {
    const known = new Map<string, Kind>();
    for (let i = 0; i < 1000; i++) known.set("a".repeat(30) + i.toString().padStart(4, "b") + "Q9", "SECRET");
    const text = "a".repeat(SIZE);
    const { ms, value } = time(() => knownSpans(text, known));
    console.log(`knownSpans 最坏前缀 ${text.length} 码元 × ${known.size} 值，命中 ${value.length}：${ms.toFixed(1)} ms`);
    expect(value).toEqual([]);
    // 人为的最坏情形（每个位置沿共同前缀走 30 步，共 3000 万步），不在 200 ms 的验收范围里；只要求仍是线性量级
    expect(ms).toBeLessThan(1000);
  });

  test("没有命中的普通文本", () => {
    const r = rng(4);
    const known = knownValues(r, 1000);
    const { text } = prose(r, ["zzzzzzzz"], true);
    const { ms, value } = time(() => knownSpans(text, known));
    console.log(`knownSpans 无命中 ${text.length} 码元：${ms.toFixed(1)} ms`);
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("modelSpans 性能（长文本、一整行、很多结果）", () => {
  test("1 MB 单行里 3000 个结果：每个结果的判断只看附近，不随文本长度增长", () => {
    const r = rng(5);
    const pieces: string[] = [];
    const finds: { start: number; end: number; label: string; score: number }[] = [];
    const labels = ["private_person", "common_secret", "phone", "email", "account", "private_address"];
    let len = 0;
    let k = 0;
    while (len < SIZE) {
      const w = pick(r, LOWER, 3 + Math.floor(r() * 6));
      pieces.push(w, " ");
      len += w.length + 1;
      if (k++ % 60 === 0) {
        const v = k % 6 === 1 ? pick(r, MIXED, 16) : pick(r, LOWER, 5) + " " + pick(r, LOWER, 6);
        finds.push({ start: len, end: len + v.length, label: labels[k % 6]!, score: 0.9 });
        pieces.push(v, " ");
        len += v.length + 1;
      }
    }
    const text = pieces.join("");
    const t0 = performance.now();
    const out = modelSpans(text, finds, opts({ threshold: 0.5 }));
    const ms = performance.now() - t0;
    console.log(`modelSpans 单行 ${text.length} 码元，${finds.length} 个结果 → ${out.length} 个区间：${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});
