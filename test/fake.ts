// T3 测试的假识别器：在文本里每个出现 values 里某个值的地方给出模型结果（AstrLink 的标签），数调用次数。

import type { Recognizer } from "../src/guard.ts";
import type { RawFind } from "../src/types.ts";

export class FakeRecognizer implements Recognizer {
  calls: string[] = [];
  delayMs = 0;
  failWith: Error | undefined;
  constructor(public values: Record<string, string>) {}

  async find(text: string): Promise<RawFind[]> {
    this.calls.push(text);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    const out: RawFind[] = [];
    for (const [v, label] of Object.entries(this.values)) {
      for (let at = 0; ; ) {
        const j = text.indexOf(v, at);
        if (j < 0) break;
        out.push({ start: j, end: j + v.length, label, score: 0.99 });
        at = j + v.length;
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
}

/** 测试用的值与标签。 */
export const VALUES: Record<string, string> = {
  "张伟": "private_person",
  "13812345678": "phone",
  "zhangwei@acme-corp.cn": "email",
  "上海市浦东新区张江路500号": "private_address",
  "6222021234567890123": "account",
};
