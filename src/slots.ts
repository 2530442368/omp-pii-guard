// 跨进程推理槽位：同一台机器上所有 omp 进程共用 <数据根目录>/slots/ 里的槽位文件，限制“同时在跑的推理窗口”总数。
// 进程内的 Limiter 只管本进程；同时恢复几十个会话时，每个进程各自跑满 limit 个窗口，机器就被占满了。
//
// 做法：slot-0 … slot-<total-1> 共 total 个槽位，每个槽位是一个文件，持有者用 openSync(…, "wx", 0o600) 排他创建，
// 内容 "pid token 时间"；释放 = 删文件（只删内容仍是自己 token 的）。没有守护进程，没有锁服务。
// - 后台（预扫描）只能用前 background 个槽位；前台（出口请求）可用全部，且先试后台用不到的槽位，
//   所以后台把自己的份额占满时，前台仍有槽位可拿。
// - 等不到就轮询（退避 + 抖动；前台间隔短、后台间隔长，让前台更容易抢到刚空出的槽位）。
// - 过期回收：持有者 pid 已死（kill -9、崩溃），或槽位文件的 mtime 超过 STALE_MS，视为过期，删掉重试。
//   已知竞态：两个进程同时判定同一个槽位过期、其中一个已经回收并重新占用时，另一个可能把新占用者的文件删掉，
//   造成短暂多占一个槽位（总数最多超出 1 个、持续到那次推理结束）。推理窗口很短，接受。
// - 进程退出（exit 事件）时同步释放本进程仍持有的槽位；SIGKILL 靠上面的过期回收兜底。
// - 槽位目录不可用（建不出来、不是自己的真实目录、运行中出错）：acquire 立即返回空释放函数，只记 debug；
//   这时只剩进程内限流，不阻塞推理（限流是性能措施，不是安全边界）。
// 旧版本进程不参与这个限流，过渡期接受。

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnDir } from "./tern.ts";

export interface GlobalSlots {
  /** 取一个跨进程推理槽位，返回释放函数（幂等）。出错退回为立即返回空释放函数，不抛。 */
  acquire(background: boolean): Promise<() => void>;
}

/** 槽位文件超过这个时长没动就视为过期（单个推理窗口只要几百毫秒到几秒）。 */
export const STALE_MS = 120_000;
/** 内容还没写完/读不出的槽位文件，超过这个时长视为过期（创建与写入之间进程就死了）。 */
const UNREADABLE_STALE_MS = 5_000;
const FOREGROUND_POLL_MS = [4, 40] as const; // [初始, 上限]
const BACKGROUND_POLL_MS = [40, 400] as const;

const noop = (): void => {};

/** 本进程持有的槽位：退出时同步释放。 */
const held = new Map<string, string>(); // 文件 → token
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const [file, token] of held) removeIfOwner(file, token);
    held.clear();
  });
}

/** 只删内容仍是自己 token 的槽位文件。 */
function removeIfOwner(file: string, token: string): void {
  try {
    const parts = fs.readFileSync(file, "utf8").split(" ");
    if (parts[1] === token) fs.unlinkSync(file);
  } catch {}
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但不属于我们：仍算活着
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function openGlobalSlots(opts: { dir: string; total: number; background: number; debug?: (m: string) => void }): GlobalSlots | undefined {
  const debug = opts.debug ?? (() => {});
  const total = Math.max(1, Math.floor(opts.total));
  const bg = Math.min(total, Math.max(1, Math.floor(opts.background)));
  try {
    ensureOwnDir(opts.dir);
  } catch (e) {
    debug(`pii-guard 跨进程槽位目录不可用，只用进程内限流：${String((e as Error)?.message ?? e)}`);
    return undefined;
  }
  hookExit();
  const file = (i: number): string => path.join(opts.dir, `slot-${i}`);
  let broken = false;

  /** 槽位 i 是否过期；是则尝试回收（删之前复核内容没变）。 */
  function reclaim(i: number): void {
    const f = file(i);
    let text: string;
    let age: number;
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile()) throw new Error("槽位不是普通文件");
      age = Date.now() - st.mtimeMs;
      text = fs.readFileSync(f, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // 刚被释放
      throw e;
    }
    const pid = Number.parseInt(text.split(" ")[0] ?? "", 10);
    const parsed = Number.isInteger(pid) && pid > 0 && text.split(" ").length >= 2;
    const stale = parsed ? !pidAlive(pid) || age > STALE_MS : age > UNREADABLE_STALE_MS;
    if (!stale) return;
    try {
      if (fs.readFileSync(f, "utf8") !== text) return; // 复核：期间被别人回收并重新占用了
      fs.unlinkSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** 试着占一个槽位；成功返回释放函数，被占着返回 undefined；目录出错抛。 */
  function tryTake(i: number): (() => void) | undefined {
    const f = file(i);
    const token = randomBytes(8).toString("hex");
    let fd: number;
    try {
      fd = fs.openSync(f, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      reclaim(i);
      try {
        fd = fs.openSync(f, "wx", 0o600);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw e2;
      }
    }
    try {
      fs.writeSync(fd, `${process.pid} ${token} ${Date.now()}`);
    } catch (e) {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(f);
      } catch {}
      throw e;
    }
    fs.closeSync(fd);
    held.set(f, token);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (held.get(f) === token) held.delete(f);
      removeIfOwner(f, token);
    };
  }

  return {
    async acquire(background: boolean): Promise<() => void> {
      if (broken) return noop;
      // 前台先试后台用不到的槽位，再试后台也能用的；后台只试前 bg 个。
      const order: number[] = [];
      if (!background) for (let i = bg; i < total; i++) order.push(i);
      for (let i = 0; i < bg; i++) order.push(i);
      const [min, max] = background ? BACKGROUND_POLL_MS : FOREGROUND_POLL_MS;
      let wait: number = min;
      try {
        for (;;) {
          for (const i of order) {
            const release = tryTake(i);
            if (release) return release;
          }
          await sleep(wait * (0.5 + Math.random())); // 抖动，避免多个进程同步重试
          wait = Math.min(max, wait * 2);
        }
      } catch (e) {
        broken = true; // 目录出了问题（被删、被换、权限变了）：退回只有进程内限流
        debug(`pii-guard 跨进程槽位出错，退回进程内限流：${String((e as Error)?.message ?? e)}`);
        return noop;
      }
    },
  };
}
