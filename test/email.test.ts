// 审查 F8：保留域名（example.com 等）按标签边界判断，不能用后缀匹配放过真实邮箱。

import { describe, expect, test } from "bun:test";
import { realEmail } from "../src/email.ts";
import { modelSpans, modelTakes } from "../src/filters.ts";

describe("F8：保留域名按标签边界判断", () => {
  test("customerexample.com 之类相似后缀是真实邮箱，example.com 与其子域不是", () => {
    for (const v of ["alice@customerexample.com", "bob@myexample.org", "x@notlocalhost.com", "li@acme-example.net"]) expect(realEmail(v)).toBe(true);
    for (const v of ["alice@example.com", "bob@mail.example.org", "x@example.net", "u@dev.localhost", "u@foo.test", "u@a.b.invalid"]) expect(realEmail(v)).toBe(false);
    expect(modelTakes("EMAIL", "alice@customerexample.com")).toBe(true);
  });

  test("模型识别出的 alice@customerexample.com 经 modelSpans 保留", () => {
    const text = "联系 alice@customerexample.com 即可";
    const at = text.indexOf("alice");
    const spans = modelSpans(text, [{ start: at, end: at + "alice@customerexample.com".length, label: "email", score: 0.99 }], {
      args: false,
      threshold: 0.8,
      kinds: new Set(["EMAIL"] as const),
      allow: new Set(),
    });
    expect(spans).toEqual([{ start: at, end: at + "alice@customerexample.com".length, kind: "EMAIL" }]);
  });
});
