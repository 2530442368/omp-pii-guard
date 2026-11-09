// 本地会话里“字面出现”的 omp 占位符外形的串。
//
// omp Hide Secrets 在本地存原值，只在发往模型的请求里把密钥换成 `$$…$$`（见 omp://secrets.md；静态系统提示不经它处理）。
// 所以：一个严格格式的 `$$…$$`，只要在本地会话历史（各类条目：消息、工具结果、自定义消息、压缩摘要、文件提及……）
// 或本地系统提示里字面出现过，它就不是 omp 生成的占位符，而是用户/工具/文件写下的字面文本（可能正是一个真实密码），
// 不能因为外形像占位符就放行。请求里出现、而本地没有的严格格式 `$$…$$` 才是 omp 刚生成的占位符，才保护。
//
// 剩余边界：不在会话分支里、也不在系统提示里的请求内容（/btw 的未落盘文本、请求时才拼进去的提醒或文件内容）里，
// 字面写出的严格格式 `$$…$$` 会被当成占位符保护。
//
// 完整性：扫描触顶（深度、节点数）或跳过了读不了的内容（Map、类实例等）时，结果只是部分的——没扫到不等于本地没有。
// collect 返回 complete=false，调用方此时不能把“没出现过”当成“本地没有”。不完整的标记随条目缓存，不会被当成完整。

import { dollarMatches } from "./mask.ts";

/** 遍历深度与节点数上限（异常大的条目不拖慢请求）。 */
const MAX_DEPTH = 12;
const MAX_NODES = 200_000;

/** 遍历一个值，把严格格式的 $$…$$ 收进 out；返回是否完整（没有因上限或读不了的内容而跳过）。 */
function walk(v: unknown, out: Set<string>, depth: number, budget: { n: number }): boolean {
  if (budget.n-- <= 0) return false;
  if (typeof v === "string") {
    for (const m of dollarMatches(v)) out.add(m);
    return true;
  }
  if (v === null || typeof v !== "object") return true; // 数字、布尔等：没有文本
  if (depth >= MAX_DEPTH) return false;
  let ok = true;
  if (Array.isArray(v)) {
    for (const x of v) if (!walk(x, out, depth + 1, budget)) ok = false;
    return ok;
  }
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Date) return true; // 二进制、日期：不是会话里的文本
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false; // Map、类实例等：读不了
  for (const x of Object.values(v)) if (!walk(x, out, depth + 1, budget)) ok = false;
  return ok;
}

interface EntryHits {
  readonly hits: readonly string[];
  readonly complete: boolean;
}

export interface LocalScan {
  /** 分支条目与系统提示里字面出现的严格格式 $$…$$。 */
  readonly literals: Set<string>;
  /** 扫描是否完整；false 时 literals 只是部分结果。 */
  readonly complete: boolean;
}

export class LocalLiterals {
  /** 条目 → 它里面的严格格式 $$…$$ 与是否扫完整（条目对象在会话里是稳定的，只扫一次）。 */
  private readonly byEntry = new WeakMap<object, EntryHits>();
  private sysText: string | undefined;
  private sysHits: readonly string[] = [];

  collect(entries: readonly unknown[], systemPrompt?: string): LocalScan {
    const all = new Set<string>();
    let complete = true;
    for (const e of entries) {
      if (e === null || e === undefined) continue;
      if (typeof e !== "object") {
        const s = new Set<string>();
        if (!walk(e, s, 0, { n: MAX_NODES })) complete = false;
        for (const h of s) all.add(h);
        continue;
      }
      let r = this.byEntry.get(e);
      if (r === undefined) {
        const s = new Set<string>();
        const ok = walk(e, s, 0, { n: MAX_NODES });
        r = { hits: [...s], complete: ok };
        this.byEntry.set(e, r);
      }
      if (!r.complete) complete = false;
      for (const h of r.hits) all.add(h);
    }
    if (typeof systemPrompt === "string" && systemPrompt !== "") {
      if (systemPrompt !== this.sysText) {
        this.sysText = systemPrompt;
        this.sysHits = dollarMatches(systemPrompt);
      }
      for (const h of this.sysHits) all.add(h);
    }
    return { literals: all, complete };
  }
}
