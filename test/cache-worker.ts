// test/cache.test.ts 的子进程：与其他进程并发读写同一个持久识别缓存，核对读到的都是正确结果。
// 子进程可能遇到别的进程正在创建库，初始化走异步重试。环境变量：CACHE_FILE、CACHE_ID、CACHE_N；可选 CACHE_START_AT（毫秒时间戳，所有进程忙等到这一刻再打开，让“同时首次创建数据库”稳定复现）。成功时向 stdout 写 "ok"。

import { openFindCache } from "../src/cache.ts";
import type { RawFind } from "../src/types.ts";

export function resultFor(text: string): RawFind[] {
  return [{ start: 0, end: Math.min(4, text.length), label: "email", score: 0.5 + (text.length % 5) / 10 }];
}

export const sharedText = (i: number): string => `共享文本-${i}-` + "x".repeat(i % 7);
export const ownText = (id: string, i: number): string => `独有文本-${id}-${i}-` + "y".repeat(i % 5);

if (import.meta.main) {
  const file = process.env.CACHE_FILE!;
  const id = process.env.CACHE_ID!;
  const n = Number(process.env.CACHE_N);
  const startAt = Number(process.env.CACHE_START_AT ?? 0);
  while (Date.now() < startAt);
  const cache = openFindCache({ file, key: () => Buffer.alloc(32, 7), revision: "r1", debug: (m) => {
      if (!m.includes("初始化遇忙")) console.error(m); // 很多进程同时首次创建时的异步退避重试是预期内的
    },
  });
  if (!cache) throw new Error("缓存没打开");
  const bad: string[] = [];
  for (let i = 0; i < n; i++) {
    await Bun.sleep(2); // 让初始化遇忙时的退避定时器有机会跑
    const own = ownText(id, i);
    cache.put(own, resultFor(own));
    const sh = sharedText(i);
    const hit = cache.getMany(new Map([["s", sh]])).get("s");
    if (hit === undefined) cache.put(sh, resultFor(sh));
    else if (JSON.stringify(hit) !== JSON.stringify(resultFor(sh))) bad.push(sh);
    if (i % 25 === 24) cache.flush();
  }
  // 初始化可能还在异步重试：等它完成再收尾（准备好之后 put 的条目 getMany 才会读到），否则暂存的条目随 close 丢弃
  for (let t = 0; t < 400; t++) {
    cache.put("探针", []);
    if (cache.getMany(new Map([["p", "探针"]])).has("p")) break;
    await Bun.sleep(25);
  }
  cache.flush();
  cache.close();
  if (bad.length > 0) throw new Error(`读到错误结果：${bad.length} 条`);
  process.stdout.write("ok");
}
