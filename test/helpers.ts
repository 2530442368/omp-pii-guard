// 测试辅助：复刻 magpie 测试里的 fakeModel，并把它的标签换成 AstrLink Guard 的标签。

import { modelSpans, type Kind, type ModelOptions, type RawFind, type Span } from "../src/filters.ts";

/** magpie 测试里用的标签（Privacy Filter 的名字）→ AstrLink Guard 的标签。 */
const toAstrlink: Record<string, string> = {
  private_person: "private_person",
  private_address: "private_address",
  private_phone: "phone",
  private_email: "email",
  account_number: "account",
  secret: "common_secret",
  private_date: "private_date",
  private_url: "url",
};

export const ALL_KINDS: ReadonlySet<Kind> = new Set<Kind>(["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT", "SECRET"]);

export function opts(over: Partial<ModelOptions> = {}): ModelOptions {
  return { args: false, threshold: 0, kinds: ALL_KINDS, allow: new Set(), ...over };
}

/**
 * fakeModel.find：在 text 里每个出现 values 里某个值的地方给出一个结果，用对应标签，
 * 值前面有一个空格时把空格也带进来（真模型会这样吃进空格）。分数 score（默认 1）。
 */
export function fakeFind(text: string, values: Record<string, string>, score = 1): RawFind[] {
  const out: RawFind[] = [];
  for (const [v, label] of Object.entries(values)) {
    for (let at = 0; ; ) {
      const j = text.indexOf(v, at);
      if (j < 0) break;
      let a = j;
      if (a > 0 && text[a - 1] === " ") a--;
      out.push({ start: a, end: j + v.length, label: toAstrlink[label] ?? label, score });
      at = j + v.length;
    }
  }
  return out;
}

/** 假模型的结果过 modelSpans。 */
export function spansOf(text: string, values: Record<string, string>, o: Partial<ModelOptions> = {}, score = 1): Span[] {
  return modelSpans(text, fakeFind(text, values, score), opts(o));
}

/** 把区间换成 {{KIND}}，返回遮后的文本。 */
export function mask(text: string, spans: readonly Span[]): string {
  let out = "";
  let last = 0;
  for (const sp of spans) {
    out += text.slice(last, sp.start) + `{{${sp.kind}}}`;
    last = sp.end;
  }
  return out + text.slice(last);
}

/** 假模型找 values，过 modelSpans，返回遮后的文本。 */
export function masked(text: string, values: Record<string, string>, o: Partial<ModelOptions> = {}): string {
  return mask(text, spansOf(text, values, o));
}

/** 区间对应的原文。 */
export function covered(text: string, spans: readonly Span[]): string[] {
  return spans.map((s) => text.slice(s.start, s.end));
}
