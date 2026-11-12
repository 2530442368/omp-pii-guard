// 跨进程推理槽位（src/slots.ts）与 Limiter 的接线。争用用真实子进程（test/slots-worker.ts），不用假时钟。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Limiter } from "../src/guard.ts";
import { openGlobalSlots, STALE_MS } from "../src/slots.ts";

const WORKER = path.join(import.meta.dir, "slots-worker.ts");
let root: string;
let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pii-slots-"));
  dir = path.join(root, "slots");
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slotFiles = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("slot-")).sort() : []);

/** 启动 worker 子进程（用当前可执行文件当 Bun：omp 里要 BUN_BE_BUN=1）。 */
function worker(env: Record<string, string>): { child: ChildProcess; out: Promise<string>; exited: Promise<number | null> } {
  const child = spawn(process.execPath, ["run", WORKER], {
    env: { ...process.env, BUN_BE_BUN: "1", SLOTS_DIR: dir, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, out: exited.then(() => out.trim()), exited };
}

/** 等子进程在 stdout 打出 "held"（已拿到槽位）。 */
function whenHeld(w: { child: ChildProcess }): Promise<void> {
  return new Promise((resolve, reject) => {
    w.child.stdout!.on("data", (d) => String(d).includes("held") && resolve());
    w.child.on("exit", () => reject(new Error("子进程在拿到槽位前退出")));
  });
}

const race = async <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => {
  let t: ReturnType<typeof setTimeout>;
  const r = await Promise.race([p, new Promise<"timeout">((res) => (t = setTimeout(() => res("timeout"), ms)))]);
  clearTimeout(t!);
  return r;
};

describe("openGlobalSlots", () => {
  test("目录权限 0700、槽位文件 0600、内容含 pid", async () => {
    const slots = openGlobalSlots({ dir, total: 2, background: 1 })!;
    const release = await slots.acquire(false);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const [f] = slotFiles();
    expect(fs.statSync(path.join(dir, f!)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, f!), "utf8").split(" ")[0]).toBe(String(process.pid));
    release();
    expect(slotFiles()).toEqual([]);
  });

  test("槽位总数：total 个之后第 total+1 个要等到有人释放", async () => {
    const slots = openGlobalSlots({ dir, total: 2, background: 1 })!;
    const a = await slots.acquire(false);
    const b = await slots.acquire(false);
    let third = false;
    const p = slots.acquire(false).then((r) => {
      third = true;
      return r;
    });
    await sleep(150);
    expect(third).toBe(false);
    expect(slotFiles().length).toBe(2);
    a();
    const c = await race(p, 3000);
    expect(c).not.toBe("timeout");
    b();
    (c as () => void)();
    expect(slotFiles()).toEqual([]);
  });

  test("释放函数幂等：第二次调用不会删掉别人后来占的同名槽位", async () => {
    const slots = openGlobalSlots({ dir, total: 1, background: 1 })!;
    const a = await slots.acquire(false);
    a();
    const b = await slots.acquire(false);
    a(); // 旧的释放函数再调一次
    expect(slotFiles()).toEqual(["slot-0"]);
    b();
    expect(slotFiles()).toEqual([]);
  });

  test("只删自己的槽位文件：内容已是别人的 token 时释放不删", async () => {
    const slots = openGlobalSlots({ dir, total: 1, background: 1 })!;
    const release = await slots.acquire(false);
    const file = path.join(dir, "slot-0");
    fs.writeFileSync(file, `${process.pid} someone-else-token ${Date.now()}`); // 模拟被回收后别人占了
    release();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("someone-else-token");
  });

  test("后台只能用前 background 个槽位；前台能拿到后台用不了的槽位", async () => {
    const slots = openGlobalSlots({ dir, total: 3, background: 1 })!;
    const bg1 = await slots.acquire(true);
    expect(slotFiles()).toEqual(["slot-0"]);
    let bg2Done = false;
    const bg2 = slots.acquire(true).then((r) => {
      bg2Done = true;
      return r;
    });
    await sleep(200);
    expect(bg2Done).toBe(false); // 后台的份额满了，排队
    expect(slotFiles()).toEqual(["slot-0"]); // 没有偷占 slot-1/2
    const fg1 = await race(slots.acquire(false), 1000); // 前台不受影响
    const fg2 = await race(slots.acquire(false), 1000);
    expect(fg1).not.toBe("timeout");
    expect(fg2).not.toBe("timeout");
    expect(slotFiles()).toEqual(["slot-0", "slot-1", "slot-2"]);
    expect(bg2Done).toBe(false);
    bg1(); // 后台份额空出，排队的后台才拿到
    const r2 = await race(bg2, 3000);
    expect(r2).not.toBe("timeout");
    (r2 as () => void)();
    (fg1 as () => void)();
    (fg2 as () => void)();
  });

  test("前台优先试后台用不到的槽位（后台份额空着时前台不占它）", async () => {
    const slots = openGlobalSlots({ dir, total: 3, background: 1 })!;
    const fg = await slots.acquire(false);
    expect(slotFiles()).toEqual(["slot-1"]);
    fg();
  });
});

describe("回收", () => {
  test("持有者进程被 kill -9：槽位被回收", async () => {
    const holder = worker({ SLOTS_TOTAL: "1", SLOTS_BG: "1", WORKER_MODE: "hold" });
    await whenHeld(holder);
    expect(slotFiles()).toEqual(["slot-0"]);
    const slots = openGlobalSlots({ dir, total: 1, background: 1 })!;
    let got = false;
    const p = slots.acquire(false).then((r) => {
      got = true;
      return r;
    });
    await sleep(150);
    expect(got).toBe(false); // 持有者还活着：不能抢
    holder.child.kill("SIGKILL");
    const release = await race(p, 5000);
    expect(release).not.toBe("timeout");
    (release as () => void)();
  }, 20_000);

  test("活着的持有者但槽位文件超过 STALE_MS：按超时回收；没超时不回收", async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "slot-0");
    fs.writeFileSync(file, `${process.pid} stuck-token ${Date.now()}`, { mode: 0o600 }); // 持有者（本进程）活着
    const slots = openGlobalSlots({ dir, total: 1, background: 1 })!;
    let got = false;
    const p = slots.acquire(false).then((r) => {
      got = true;
      return r;
    });
    await sleep(200);
    expect(got).toBe(false);
    const old = new Date(Date.now() - STALE_MS - 5_000);
    fs.utimesSync(file, old, old);
    const release = await race(p, 3000);
    expect(release).not.toBe("timeout");
    expect(fs.readFileSync(file, "utf8")).not.toContain("stuck-token");
    (release as () => void)();
  });

  test("槽位文件内容是垃圾：新的不回收，久了才回收", async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "slot-0");
    fs.writeFileSync(file, "", { mode: 0o600 });
    const slots = openGlobalSlots({ dir, total: 1, background: 1 })!;
    let got = false;
    const p = slots.acquire(false).then((r) => {
      got = true;
      return r;
    });
    await sleep(200);
    expect(got).toBe(false);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const release = await race(p, 3000);
    expect(release).not.toBe("timeout");
    (release as () => void)();
  });

  test("进程退出（不调释放）时同步释放槽位", async () => {
    const w = worker({ SLOTS_TOTAL: "1", SLOTS_BG: "1", WORKER_MODE: "exit-held" });
    expect(await w.exited).toBe(0);
    expect(slotFiles()).toEqual([]);
  }, 20_000);
});

describe("跨进程争用（真实子进程）", () => {
  test("同时持有的槽位数 ≤ total，后台 ≤ background", async () => {
    const holdDir = path.join(root, "hold");
    fs.mkdirSync(holdDir);
    const base = { SLOTS_TOTAL: "3", SLOTS_BG: "1", HOLD_DIR: holdDir, WORKER_MODE: "contend", ITERATIONS: "12" };
    const ws = [
      ...[0, 1, 2, 3].map(() => worker({ ...base, WORKER_BG: "1" })),
      ...[0, 1, 2, 3].map(() => worker({ ...base, WORKER_BG: "0" })),
    ];
    const results = (await Promise.all(ws.map((w) => w.out))).map((o) => JSON.parse(o) as { maxTotal: number; maxBg: number; iterations: number });
    for (const r of results) expect(r.iterations).toBe(12);
    const maxTotal = Math.max(...results.map((r) => r.maxTotal));
    const maxBg = Math.max(...results.map((r) => r.maxBg));
    expect(maxTotal).toBeLessThanOrEqual(3);
    expect(maxBg).toBeLessThanOrEqual(1);
    expect(maxTotal).toBeGreaterThanOrEqual(2); // 确实有并行（不是整体串行）
    expect(slotFiles()).toEqual([]); // 全部释放
  }, 60_000);

  test("后台把份额占满并排队时，前台进程仍能拿到槽位", async () => {
    const holdDir = path.join(root, "hold");
    fs.mkdirSync(holdDir);
    const bgHolder = worker({ SLOTS_TOTAL: "2", SLOTS_BG: "1", WORKER_MODE: "hold", WORKER_BG: "1" });
    await whenHeld(bgHolder);
    const bgWaiter = worker({ SLOTS_TOTAL: "2", SLOTS_BG: "1", WORKER_MODE: "contend", WORKER_BG: "1", HOLD_DIR: holdDir, ITERATIONS: "1" });
    await sleep(300);
    const fg = worker({ SLOTS_TOTAL: "2", SLOTS_BG: "1", WORKER_MODE: "contend", WORKER_BG: "0", HOLD_DIR: holdDir, ITERATIONS: "3" });
    const r = await race(fg.out, 15_000);
    expect(r).not.toBe("timeout");
    expect(JSON.parse(r as string).iterations).toBe(3);
    expect(bgWaiter.child.exitCode).toBeNull(); // 后台等待者仍在排队
    bgHolder.child.kill("SIGKILL"); // 让后台等待者回收后完成
    expect(JSON.parse((await race(bgWaiter.out, 15_000)) as string).iterations).toBe(1);
  }, 60_000);
});

describe("目录不可用", () => {
  test("目录是符号链接：openGlobalSlots 返回 undefined，只记 debug", () => {
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(path.join(root, "elsewhere"), dir);
    const msgs: string[] = [];
    expect(openGlobalSlots({ dir, total: 2, background: 1, debug: (m) => msgs.push(m) })).toBeUndefined();
    expect(msgs.length).toBe(1);
    expect(fs.readdirSync(path.join(root, "elsewhere"))).toEqual([]); // 没写穿
  });

  test("运行中目录被换成文件：acquire 立即返回空释放函数，不抛、不阻塞", async () => {
    const msgs: string[] = [];
    const slots = openGlobalSlots({ dir, total: 1, background: 1, debug: (m) => msgs.push(m) })!;
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, "not a dir");
    const release = await race(slots.acquire(false), 2000);
    expect(release).not.toBe("timeout");
    expect(typeof release).toBe("function");
    (release as () => void)();
    expect(msgs.length).toBe(1);
    // 之后一直是空实现：不会再碰文件系统，也不阻塞
    expect(await race(slots.acquire(true), 1000)).not.toBe("timeout");
  });

  test("退回进程内限流：Limiter 的并发上限仍然成立", async () => {
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(path.join(root, "elsewhere"), dir);
    const limiter = new Limiter(2, openGlobalSlots({ dir, total: 2, background: 1 }));
    let running = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          running++;
          max = Math.max(max, running);
          await sleep(20);
          running--;
        }),
      ),
    );
    expect(max).toBe(2);
  });
});

describe("Limiter 接线", () => {
  test("进程内名额 2、跨进程槽位 1：同时在跑的 ≤ 1，且推理期间持有槽位、结束后释放", async () => {
    const limiter = new Limiter(2, openGlobalSlots({ dir, total: 1, background: 1 }));
    let running = 0;
    let max = 0;
    const seen: string[][] = [];
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        limiter.run(async () => {
          running++;
          max = Math.max(max, running);
          seen.push(slotFiles());
          await sleep(20);
          running--;
        }, i % 2 === 1),
      ),
    );
    expect(max).toBe(1);
    expect(seen.every((s) => s.length === 1)).toBe(true);
    expect(slotFiles()).toEqual([]);
  });

  test("fn 抛错也释放跨进程槽位与进程内名额", async () => {
    const limiter = new Limiter(1, openGlobalSlots({ dir, total: 1, background: 1 }));
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(slotFiles()).toEqual([]);
    expect(await limiter.run(async () => 42)).toBe(42);
  });

  test("进程内：前台排在后台前面仍然成立", async () => {
    const limiter = new Limiter(1, openGlobalSlots({ dir, total: 1, background: 1 }));
    const order: string[] = [];
    const first = limiter.run(async () => {
      await sleep(50);
    });
    const bg = limiter.run(async () => void order.push("bg"), true);
    const fg = limiter.run(async () => void order.push("fg"), false);
    await Promise.all([first, bg, fg]);
    expect(order).toEqual(["fg", "bg"]);
  });

  test("不给 global：行为与原来一致", async () => {
    const limiter = new Limiter(1);
    expect(await limiter.run(async () => "ok")).toBe("ok");
  });
});
