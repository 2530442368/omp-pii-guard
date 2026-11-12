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

describe("等待上限与伪造的槽位文件", () => {
  const preset = (n: number, content: (i: number) => string, mtime?: Date) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < n; i++) {
      const f = path.join(dir, `slot-${i}`);
      fs.writeFileSync(f, content(i), { mode: 0o600 });
      if (mtime) fs.utimesSync(f, mtime, mtime);
    }
  };

  test("mtime 在远期的伪造槽位（存活 pid）：被当作过期回收，不会一直等", async () => {
    const future = new Date(Date.now() + 365 * 86_400_000);
    preset(3, (i) => `${process.pid} forged-${i} ${Date.now()}`, future);
    const slots = openGlobalSlots({ dir, total: 3, background: 1 })!;
    const fg = await race(slots.acquire(false), 2000);
    const bg = await race(slots.acquire(true), 2000);
    expect(fg).not.toBe("timeout");
    expect(bg).not.toBe("timeout");
    const mine = slotFiles().filter((f) => !fs.readFileSync(path.join(dir, f), "utf8").includes("forged"));
    expect(mine.length).toBe(2); // 前台、后台各回收并占了一个
    (fg as () => void)();
    (bg as () => void)();
  });

  test("时钟小抖动内（未来几秒）不算伪造", async () => {
    const soon = new Date(Date.now() + 1_000);
    preset(1, () => `${process.pid} live-token ${Date.now()}`, soon);
    const msgs: string[] = [];
    const slots = openGlobalSlots({ dir, total: 1, background: 1, debug: (m) => msgs.push(m), maxWaitMs: { foreground: 300 } })!;
    const t0 = Date.now();
    await slots.acquire(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // 没被回收，等到了上限
    expect(fs.readFileSync(path.join(dir, "slot-0"), "utf8")).toContain("live-token");
  });

  test("槽位被存活持有者占满：前台、后台都在各自的上限内返回空释放函数并记 debug", async () => {
    preset(2, (i) => `${process.pid} busy-${i} ${Date.now()}`);
    const msgs: string[] = [];
    const slots = openGlobalSlots({ dir, total: 2, background: 1, debug: (m) => msgs.push(m), maxWaitMs: { foreground: 300, background: 600 } })!;
    let t0 = Date.now();
    const fg = await slots.acquire(false);
    const fgMs = Date.now() - t0;
    t0 = Date.now();
    const bg = await slots.acquire(true);
    const bgMs = Date.now() - t0;
    expect(fgMs).toBeGreaterThanOrEqual(250);
    expect(fgMs).toBeLessThan(2500);
    expect(bgMs).toBeGreaterThanOrEqual(550);
    expect(bgMs).toBeLessThan(3000);
    fg();
    bg();
    expect(slotFiles().length).toBe(2); // 空释放函数没删别人的文件
    for (const f of slotFiles()) expect(fs.readFileSync(path.join(dir, f), "utf8")).toContain("busy-");
    expect(msgs.length).toBe(2);
    // 超时不影响之后：槽位空出来就能正常取到
    fs.unlinkSync(path.join(dir, "slot-0"));
    const r = await slots.acquire(false);
    expect(fs.readFileSync(path.join(dir, "slot-0"), "utf8")).not.toContain("busy-");
    r();
  });
});

describe("目录被运行中替换", () => {
  /** 把 dir 换成指向 elsewhere 的符号链接；elsewhere 里预置一个“看起来过期、内容为 token 的”slot-0 与无关文件。 */
  function swap(token: string): string {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "slot-0"), `999999999 ${token} 1`); // 死 pid：若被当作自家目录会被回收
    fs.writeFileSync(path.join(elsewhere, "keep.txt"), "keep");
    fs.renameSync(dir, path.join(root, "moved-away"));
    fs.symlinkSync(elsewhere, dir);
    return elsewhere;
  }

  test("初始化后目录被换成符号链接：不在目录外创建或回收槽位文件，acquire 退回空释放函数", async () => {
    const msgs: string[] = [];
    const slots = openGlobalSlots({ dir, total: 2, background: 1, debug: (m) => msgs.push(m) })!;
    const elsewhere = swap("other-token");
    const release = await race(slots.acquire(false), 2000);
    expect(release).not.toBe("timeout");
    (release as () => void)();
    expect(fs.readdirSync(elsewhere).sort()).toEqual(["keep.txt", "slot-0"]); // 没有新的 slot-*
    expect(fs.readFileSync(path.join(elsewhere, "slot-0"), "utf8")).toBe("999999999 other-token 1"); // 没被回收
    expect(msgs.length).toBe(1);
  });

  test("持有槽位后目录被换掉：释放不会删目录外的同名文件（即使内容 token 相同）", async () => {
    const slots = openGlobalSlots({ dir, total: 1, background: 1 })!;
    const release = await slots.acquire(false);
    const token = fs.readFileSync(path.join(dir, "slot-0"), "utf8").split(" ")[1]!;
    const elsewhere = swap(token);
    release();
    expect(fs.readFileSync(path.join(elsewhere, "slot-0"), "utf8")).toBe(`999999999 ${token} 1`);
    expect(fs.existsSync(path.join(elsewhere, "keep.txt"))).toBe(true);
  });

  test("目录被换成另一个真实目录（inode 不同）同样不认", async () => {
    const slots = openGlobalSlots({ dir, total: 1, background: 1 })!;
    fs.renameSync(dir, path.join(root, "moved-away"));
    fs.mkdirSync(dir, { mode: 0o700 });
    const release = await race(slots.acquire(false), 2000);
    expect(release).not.toBe("timeout");
    (release as () => void)();
    expect(fs.readdirSync(dir)).toEqual([]);
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

  test("另一个进程长期持有唯一的后台槽位、本进程排着多个后台任务：前台任务立即拿到槽位并完成", async () => {
    const holder = worker({ SLOTS_TOTAL: "3", SLOTS_BG: "1", WORKER_MODE: "hold", WORKER_BG: "1" });
    await whenHeld(holder);
    const limiter = new Limiter(3, openGlobalSlots({ dir, total: 3, background: 1 }));
    let bgDone = 0;
    const bgs = Array.from({ length: 5 }, () => limiter.run(async () => void bgDone++, true));
    await sleep(200); // 后台任务都在等 slot-0
    expect(bgDone).toBe(0);
    const t0 = Date.now();
    const fgs = await race(Promise.all([limiter.run(async () => "a"), limiter.run(async () => "b")]), 3000);
    expect(fgs).toEqual(["a", "b"]);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(bgDone).toBe(0); // 后台仍排着
    holder.child.kill("SIGKILL"); // 槽位回收后后台任务依次完成
    await race(Promise.all(bgs), 15_000);
    expect(bgDone).toBe(5);
    expect(slotFiles()).toEqual([]);
  }, 30_000);

  test("global 没给 background 份额：后台的进程内名额取 limit 的一半，前台总有名额", async () => {
    const gate = Promise.withResolvers<void>();
    const fake = { acquire: async (bg: boolean) => (bg ? gate.promise.then(() => () => {}) : () => {}) }; // 后台一直等，前台不等
    const limiter = new Limiter(4, fake);
    let bgDone = 0;
    const bgs = Array.from({ length: 6 }, () => limiter.run(async () => void bgDone++, true));
    await sleep(50);
    expect(await race(limiter.run(async () => "fg"), 1000)).toBe("fg"); // 6 个后台只占 2 个进程内名额
    expect(await race(limiter.run(async () => "fg2"), 1000)).toBe("fg2");
    expect(bgDone).toBe(0);
    gate.resolve();
    await race(Promise.all(bgs), 5000);
    expect(bgDone).toBe(6);
  });

  test("global.background 给了份额：后台进程内名额等于它", async () => {
    const gate = Promise.withResolvers<void>();
    let waitingForGlobal = 0;
    const fake = {
      background: 3,
      acquire: async (bg: boolean) => {
        if (!bg) return () => {};
        waitingForGlobal++;
        await gate.promise;
        return () => {};
      },
    };
    const limiter = new Limiter(5, fake);
    const bgs = Array.from({ length: 8 }, () => limiter.run(async () => {}, true));
    await sleep(50);
    expect(waitingForGlobal).toBe(3);
    gate.resolve();
    await race(Promise.all(bgs), 5000);
  });
});
