import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openFindCache, parseFinds, type FindCache } from "../src/cache.ts";
import { defaultConfig } from "../src/config.ts";
import { MaskTimeout, Masker, sha } from "../src/mask.ts";
import { Placeholders } from "../src/placeholder.ts";
import type { RawFind } from "../src/types.ts";
import { ownText, resultFor, sharedText } from "./cache-worker.ts";
import { FakeRecognizer, VALUES } from "./fake.ts";

const KEY = Buffer.alloc(32, 7);
let root: string;
let file: string;
const opened: FindCache[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pii-cache-"));
  file = path.join(root, "cache", "finds.sqlite");
});
afterEach(() => {
  setSystemTime();
  for (const c of opened.splice(0)) c.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function open(over: Partial<Parameters<typeof openFindCache>[0]> = {}): FindCache {
  const c = openFindCache({ file, key: () => KEY, revision: "r1", ...over });
  if (!c) throw new Error("缓存没打开");
  opened.push(c);
  return c;
}

const F = (start: number, end: number, label = "phone", score = 0.9): RawFind => ({ start, end, label, score });
const one = (text: string): Map<string, string> => new Map([[sha(text), text]]);
const rawDb = (): Database => new Database(file);

function maskerWith(cache: (() => FindCache | undefined) | undefined, values: Record<string, string> = VALUES) {
  const rec = new FakeRecognizer(values);
  const cfg = defaultConfig();
  const ph = new Placeholders(() => KEY);
  return { rec, ph, masker: new Masker(async () => rec, ph, () => cfg, cache) };
}

const items = (...texts: string[]) => texts.map((text) => ({ text, args: false }));
const TEXTS = [
  "联系人张伟，手机 13812345678，邮箱 zhangwei@acme-corp.cn",
  "地址 上海市浦东新区张江路500号 张江路，卡号 6222021234567890123",
  "没有任何个人信息的一段普通文字，用来确认空结果也能缓存。",
];

describe("持久识别缓存：读写与校验", () => {
  test("put → flush → 另一个连接读到相同结果；空结果也命中", () => {
    const a = open();
    const t1 = "手机 13800000000 请回电";
    a.put(t1, [F(3, 14)]);
    a.put("没有个人信息", []);
    a.flush();
    const b = open();
    expect(b.getMany(one(t1)).get(sha(t1))).toEqual([F(3, 14)]);
    expect(b.getMany(one("没有个人信息")).get(sha("没有个人信息"))).toEqual([]);
    expect(b.getMany(one("没扫过的文本")).size).toBe(0);
  });

  test("未落盘的条目同一实例也读得到", () => {
    const a = open();
    a.put("手机 13800000000", [F(3, 14)]);
    expect(a.getMany(one("手机 13800000000")).size).toBe(1);
  });

  test("一次查询里混合命中与未命中（超过一个分块）", () => {
    const a = open();
    const texts = Array.from({ length: 900 }, (_, i) => `文本 ${i} 联系电话 1380000${String(i).padStart(4, "0")}`);
    for (let i = 0; i < texts.length; i += 2) a.put(texts[i]!, [F(0, 2)]);
    a.flush();
    const got = open().getMany(new Map(texts.map((t) => [sha(t), t])));
    expect(got.size).toBe(450);
    for (let i = 0; i < texts.length; i++) expect(got.has(sha(texts[i]!))).toBe(i % 2 === 0);
  });

  test("改模型修订或密钥后不命中，原参数仍命中", () => {
    const a = open();
    a.put("手机 13800000000", [F(3, 14)]);
    a.flush();
    expect(open({ revision: "r2" }).getMany(one("手机 13800000000")).size).toBe(0);
    expect(open({ key: () => Buffer.alloc(32, 8) }).getMany(one("手机 13800000000")).size).toBe(0);
    expect(open().getMany(one("手机 13800000000")).size).toBe(1);
  });

  test("密钥读取失败：当作未命中，不抛", () => {
    const a = open({
      key: () => {
        throw new Error("没有密钥");
      },
    });
    expect(a.getMany(one("手机 13800000000")).size).toBe(0);
    expect(() => a.put("手机 13800000000", [F(3, 14)])).not.toThrow();
    expect(() => a.flush()).not.toThrow();
  });

  test("不合法的写入不存（位置越界、标签不在表内、分数非法）", () => {
    const a = open();
    const t = "手机 13800000000";
    for (const bad of [F(0, 99), F(5, 5), F(-1, 3), F(0.5, 3), F(0, 3, "bogus"), F(0, 3, "O"), F(0, 3, "phone", 1.5), F(0, 3, "phone", Number.NaN)]) {
      a.put(t, [bad]);
      a.flush();
      expect(open().getMany(one(t)).size).toBe(0);
    }
  });

  test("被篡改或损坏的行当作未命中，重新推理后会被覆盖", () => {
    const a = open();
    const t = "手机 13800000000 请回电";
    a.put(t, [F(3, 14)]);
    a.flush();
    const db = rawDb();
    const bads = [
      "不是 JSON",
      '{"a":1}',
      '[[0,2,"phone"]]',
      '[[2,2,"phone",0.9]]',
      '[[-1,2,"phone",0.9]]',
      '[[0,1000,"phone",0.9]]',
      '[[0.5,2,"phone",0.9]]',
      '[["0",2,"phone",0.9]]',
      '[[0,2,"bogus",0.9]]',
      '[[0,2,"O",0.9]]',
      '[[0,2,"B-phone",0.9]]',
      '[[0,2,"phone",1.5]]',
      '[[0,2,"phone",-0.1]]',
      '[[0,2,"phone",null]]',
      '[[0,2,"phone","0.9"]]',
      "[1]",
      "null",
    ];
    for (const bad of bads) {
      db.prepare("UPDATE finds SET v = ?").run(bad);
      expect(open().getMany(one(t)).size, bad).toBe(0);
    }
    db.prepare("UPDATE finds SET v = ?").run(123 as unknown as string); // 非文本列
    expect(open().getMany(one(t)).size).toBe(0);
    db.close();
    const b = open();
    b.put(t, [F(3, 14)]);
    b.flush();
    expect(open().getMany(one(t)).get(sha(t))).toEqual([F(3, 14)]);
  });

  test("parseFinds：边界与合法值", () => {
    expect(parseFinds("[]", 0)).toEqual([]);
    expect(parseFinds('[[0,3,"email",0]]', 3)).toEqual([F(0, 3, "email", 0)]);
    expect(parseFinds('[[0,3,"email",1]]', 2)).toBeUndefined();
    expect(parseFinds(undefined, 3)).toBeUndefined();
  });
});

describe("持久识别缓存：隐私与权限", () => {
  test("数据库（含 WAL）的字节里找不到原文、原值、占位符", () => {
    const a = open();
    const { masker } = maskerWith(() => a);
    const needles = [...TEXTS, "张伟", "13812345678", "zhangwei@acme-corp.cn", "上海市浦东新区张江路500号", "6222021234567890123", "张江路", "PHONE_", "PERSON_", "联系人"];
    const scan = (): void => {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        if (!fs.existsSync(f)) continue;
        const bytes = fs.readFileSync(f);
        for (const n of needles) expect(bytes.includes(Buffer.from(n)), `${path.basename(f)} 含 ${n}`).toBe(false);
      }
    };
    return masker.maskTexts(items(...TEXTS)).then(() => {
      a.flush();
      expect(fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0)).toBeGreaterThan(0);
      scan();
      a.close();
      scan();
    });
  });

  test("目录 0700，数据库与 -wal/-shm 为 0600", () => {
    fs.mkdirSync(path.dirname(file), { mode: 0o755 });
    fs.chmodSync(path.dirname(file), 0o755);
    const a = open();
    a.put("手机 13800000000", [F(3, 14)]);
    a.flush();
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    for (const s of ["-wal", "-shm"]) if (fs.existsSync(file + s)) expect(fs.statSync(file + s).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
  });

  test("已有数据库权限被放宽时收紧到 0600", () => {
    open().close();
    fs.chmodSync(file, 0o644);
    open();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("持久识别缓存：损坏与不安全目录", () => {
  test("损坏的文件：删除重建，之后可正常读写", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "这不是 sqlite 数据库".repeat(500));
    fs.writeFileSync(`${file}-wal`, "垃圾 wal");
    const msgs: string[] = [];
    const a = open({ debug: (m) => msgs.push(m) });
    a.put("手机 13800000000", [F(3, 14)]);
    a.flush();
    expect(open().getMany(one("手机 13800000000")).size).toBe(1);
    expect(msgs.some((m) => m.includes("损坏"))).toBe(true);
  });

  test("版本不符的数据库：重建", () => {
    open().close();
    const db = rawDb();
    db.exec("PRAGMA user_version=99");
    db.close();
    const a = open();
    a.put("手机 13800000000", [F(3, 14)]);
    a.flush();
    expect(open().getMany(one("手机 13800000000")).size).toBe(1);
  });

  test("数据库文件是符号链接：换成普通文件，不写穿到链接目标", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const victim = path.join(root, "victim");
    fs.writeFileSync(victim, "不要动我");
    fs.symlinkSync(victim, file);
    const a = open();
    a.put("手机 13800000000", [F(3, 14)]);
    a.flush();
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("不要动我");
  });

  test("目录是符号链接：不启用缓存，不报错，不写到链接目标", () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const msgs: string[] = [];
    expect(openFindCache({ file: path.join(link, "finds.sqlite"), key: () => KEY, revision: "r1", debug: (m) => msgs.push(m) })).toBeUndefined();
    expect(fs.readdirSync(real)).toEqual([]);
    expect(msgs.length).toBe(1);
  });

  test("目录位置被普通文件占着：不启用缓存，不抛", () => {
    fs.writeFileSync(path.join(root, "cache"), "占位");
    expect(openFindCache({ file, key: () => KEY, revision: "r1" })).toBeUndefined();
  });

  test("关闭后调用不抛、读不到", () => {
    const a = open();
    a.put("手机 13800000000", [F(3, 14)]);
    a.close();
    a.close();
    expect(() => a.put("别的文本", [F(0, 2)])).not.toThrow();
    expect(a.getMany(one("手机 13800000000")).size).toBe(0);
    expect(() => a.flush()).not.toThrow();
    expect(open().getMany(one("手机 13800000000")).size).toBe(1); // close 前已落盘
  });
});

describe("持久识别缓存：容量与使用日", () => {
  const DAY = 86_400_000;
  const rowCount = (): number => {
    const db = rawDb();
    const n = (db.prepare("SELECT count(*) AS c FROM finds").get() as { c: number }).c;
    db.close();
    return n;
  };

  test("超过上限：按最近使用日淘汰到 90%，新的保留", () => {
    const a = open({ maxEntries: 20 });
    const old = Array.from({ length: 15 }, (_, i) => `旧文本 ${i} 号码`);
    const fresh = Array.from({ length: 15 }, (_, i) => `新文本 ${i} 号码`);
    setSystemTime(new Date(1 * DAY));
    for (const t of old) a.put(t, [F(0, 2)]);
    a.flush();
    expect(rowCount()).toBe(15);
    setSystemTime(new Date(5 * DAY));
    for (const t of fresh) a.put(t, [F(0, 2)]);
    a.flush();
    expect(rowCount()).toBe(18); // 30 条 → 淘汰到 floor(20 × 0.9)
    const b = open();
    expect(b.getMany(new Map(fresh.map((t) => [sha(t), t]))).size).toBe(15);
    expect(b.getMany(new Map(old.map((t) => [sha(t), t]))).size).toBe(3);
  });

  test("命中时只在使用日变了才更新使用日", () => {
    const a = open();
    setSystemTime(new Date(2 * DAY));
    a.put("手机 13800000000", [F(3, 14)]);
    a.flush();
    const dayOf = (): number => {
      const db = rawDb();
      const d = (db.prepare("SELECT day FROM finds").get() as { day: number }).day;
      db.close();
      return d;
    };
    expect(dayOf()).toBe(2);
    setSystemTime(new Date(2 * DAY + 3600_000));
    const b = open();
    b.getMany(one("手机 13800000000"));
    b.flush();
    expect(dayOf()).toBe(2);
    setSystemTime(new Date(9 * DAY));
    b.getMany(one("手机 13800000000"));
    b.flush();
    expect(dayOf()).toBe(9);
  });

  test("攒够一批自动写入", () => {
    const a = open();
    for (let i = 0; i < 200; i++) a.put(`批量文本 ${i} 号码`, [F(0, 2)]);
    expect(rowCount()).toBe(200); // 没手动 flush
  });
});

describe("持久识别缓存：多进程", () => {
  test("多个子进程同时读写同一个数据库：不出错，读到的都正确，最终全部命中", async () => {
    const worker = path.join(import.meta.dir, "cache-worker.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const N = 150;
    const ids = ["a", "b", "c", "d", "e", "f"];
    const procs = ids.map((id) =>
      Bun.spawn([process.execPath, "run", worker], {
        env: { ...process.env, BUN_BE_BUN: "1", CACHE_FILE: file, CACHE_ID: id, CACHE_N: String(N) },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
    for (const r of results) {
      expect(r.err).toBe("");
      expect(r.out).toBe("ok");
      expect(r.code).toBe(0);
    }
    const c = open();
    const want = new Map<string, string>();
    for (let i = 0; i < N; i++) {
      want.set(sha(sharedText(i)), sharedText(i));
      for (const id of ids) want.set(sha(ownText(id, i)), ownText(id, i));
    }
    const got = c.getMany(want);
    expect(got.size).toBe(want.size);
    for (const [h, text] of want) expect(got.get(h)).toEqual(resultFor(text));
  }, 60_000);
});

describe("Masker 接入持久缓存", () => {
  test("第二个 Masker（新进程等价：新实例、同一数据库）对已扫文本零推理，产出相同", async () => {
    const c1 = open();
    const m1 = maskerWith(() => c1);
    const first = await m1.masker.maskTexts(items(...TEXTS));
    expect(m1.rec.calls.length).toBe(TEXTS.length);
    c1.flush();

    const c2 = open();
    const m2 = maskerWith(() => c2);
    const second = await m2.masker.maskTexts(items(...TEXTS));
    expect(m2.rec.calls.length).toBe(0);
    expect(second).toEqual(first);
    expect(m2.ph.restoreText(second[0]!)).toBe(TEXTS[0]!);
  });

  test("prescan 也命中持久缓存", async () => {
    const c1 = open();
    await maskerWith(() => c1).masker.prescan(items(...TEXTS));
    c1.flush();
    const c2 = open();
    const m2 = maskerWith(() => c2);
    await m2.masker.prescan(items(...TEXTS));
    expect(m2.rec.calls.length).toBe(0);
    await m2.masker.maskTexts(items(...TEXTS));
    expect(m2.rec.calls.length).toBe(0);
  });

  test("没有缓存、缓存还没就绪（返回 undefined）、取缓存时抛错：与无缓存一致", async () => {
    const base = await maskerWith(undefined).masker.maskTexts(items(...TEXTS));
    expect(await maskerWith(() => undefined).masker.maskTexts(items(...TEXTS))).toEqual(base);
    const m = maskerWith(() => {
      throw new Error("取缓存失败");
    });
    expect(await m.masker.maskTexts(items(...TEXTS))).toEqual(base);
    expect(m.rec.calls.length).toBe(TEXTS.length);
  });

  test("缓存的读写都抛错：遮挡结果与无缓存一致，照常推理", async () => {
    const base = await maskerWith(undefined).masker.maskTexts(items(...TEXTS));
    const broken: FindCache = {
      getMany() {
        throw new Error("读失败");
      },
      put() {
        throw new Error("写失败");
      },
      flush() {},
      close() {},
    };
    const m = maskerWith(() => broken);
    expect(await m.masker.maskTexts(items(...TEXTS))).toEqual(base);
    expect(m.rec.calls.length).toBe(TEXTS.length);
  });

  test("缓存已关闭 / 数据库被删：当作未命中，遮挡不少于无缓存", async () => {
    const base = await maskerWith(undefined).masker.maskTexts(items(...TEXTS));
    const c = open();
    c.close();
    const m = maskerWith(() => c);
    expect(await m.masker.maskTexts(items(...TEXTS))).toEqual(base);
    expect(m.rec.calls.length).toBe(TEXTS.length);
  });

  test("缓存命中的结果与推理结果的遮挡产出一致（含不同语境的 args）", async () => {
    const c1 = open();
    const base = await maskerWith(() => c1).masker.maskTexts([...items(...TEXTS), { text: TEXTS[0]!, args: true }]);
    c1.flush();
    const c2 = open();
    const m2 = maskerWith(() => c2);
    expect(await m2.masker.maskTexts([...items(...TEXTS), { text: TEXTS[0]!, args: true }])).toEqual(base);
    expect(m2.rec.calls.length).toBe(0);
  });

  test("出口超时后在后台完成的推理也写进持久缓存", async () => {
    const c1 = open();
    const m = maskerWith(() => c1);
    m.rec.delayMs = 150;
    await expect(m.masker.maskTexts(items(TEXTS[0]!), { deadline: Date.now() + 20 })).rejects.toBeInstanceOf(MaskTimeout);
    expect(c1.getMany(one(TEXTS[0]!)).size).toBe(0); // 推理还没完成
    await new Promise((r) => setTimeout(r, 500));
    c1.flush();
    const c2 = open();
    const m2 = maskerWith(() => c2);
    await m2.masker.maskTexts(items(TEXTS[0]!));
    expect(m2.rec.calls.length).toBe(0);
  });

  test("推理失败不写缓存", async () => {
    const c1 = open();
    const m = maskerWith(() => c1);
    m.rec.failWith = new Error("推理失败");
    await expect(m.masker.maskTexts(items(TEXTS[0]!))).rejects.toThrow("推理失败");
    c1.flush();
    expect(open().getMany(one(TEXTS[0]!)).size).toBe(0);
  });

  test("飞行中的同一文本不重复查缓存或推理", async () => {
    const c1 = open();
    const m = maskerWith(() => c1);
    m.rec.delayMs = 50;
    await Promise.all([m.masker.maskTexts(items(TEXTS[0]!)), m.masker.maskTexts(items(TEXTS[0]!))]);
    expect(m.rec.calls.length).toBe(1);
  });
});
