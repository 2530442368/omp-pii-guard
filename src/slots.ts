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
// - mtime 在未来（超过 FUTURE_SLACK_MS）的槽位文件一律视为过期：否则能写目录的人把 mtime 设到远期，就能让所有进程长期等不到槽位。
// - 每次 acquire 有等待上限（前台 10 s、后台 60 s）：到点不取全局槽位、直接继续（只记 debug），所以槽位目录里
//   无论出什么状况，推理都不会被无限挡住；上限内能等到正常的空位。
// - 目录身份：打开时记下槽位目录的 dev+ino，之后每次创建、回收、释放前都用 lstat 复核“仍是同一个真实目录”；
//   运行中被换成符号链接或别的目录时，不在目录外创建或删除任何文件，退回进程内限流。
//   lstat 与随后的 open/unlink 之间仍有极短的窗口（Node 没有 openat），接受；槽位目录本身是 0700 属主目录，
//   能换它的只有同一用户（与改 config.json 同级，见 README 威胁模型）。
// - 槽位目录不可用（建不出来、不是自己的真实目录、运行中出错）：acquire 立即返回空释放函数，只记 debug；
//   这时只剩进程内限流，不阻塞推理（限流是性能措施，不是安全边界）。
// 旧版本进程不参与这个限流，过渡期接受。

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnDir } from "./tern.ts";

export interface GlobalSlots {
  /** 后台（预扫描）最多可同时持有的槽位数；Limiter 据此限制本进程里后台任务的进程内名额。没给时 Limiter 取进程内名额的一半。 */
  readonly background?: number;
  /** 取一个跨进程推理槽位，返回释放函数（幂等）。出错退回为立即返回空释放函数，不抛。 */
  acquire(background: boolean): Promise<() => void>;
}

/** 槽位文件超过这个时长没动就视为过期（单个推理窗口只要几百毫秒到几秒）。 */
export const STALE_MS = 120_000;
/** 内容还没写完/读不出的槽位文件，超过这个时长视为过期（创建与写入之间进程就死了）。 */
const UNREADABLE_STALE_MS = 5_000;
/** 槽位文件 mtime 比当前时间晚多少以内算时钟抖动（超过则视为伪造/异常，过期）。 */
const FUTURE_SLACK_MS = 5_000;
/** acquire 的等待上限：到点就不取全局槽位直接继续。 */
const FOREGROUND_MAX_WAIT_MS = 10_000;
const BACKGROUND_MAX_WAIT_MS = 60_000;
const FOREGROUND_POLL_MS = [4, 40] as const; // [初始, 上限]
const BACKGROUND_POLL_MS = [40, 400] as const;

const noop = (): void => {};

/** 本进程持有的槽位：退出时同步释放。 */
const held = new Map<string, { token: string; dirOk: () => boolean }>(); // 文件 → token 与“目录仍是原来那个”的检查
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const [file, h] of held) if (h.dirOk()) removeIfOwner(file, h.token);
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

export function openGlobalSlots(opts: {
  dir: string;
  total: number;
  background: number;
  debug?: (m: string) => void;
  /** acquire 的等待上限（毫秒），默认前台 10 s、后台 60 s；测试用。 */
  maxWaitMs?: { foreground?: number; background?: number };
}): GlobalSlots | undefined {
  const debug = opts.debug ?? (() => {});
  const total = Math.max(1, Math.floor(opts.total));
  const bg = Math.min(total, Math.max(1, Math.floor(opts.background)));
  let identity: { dev: number; ino: number };
  try {
    ensureOwnDir(opts.dir);
    const st = fs.lstatSync(opts.dir);
    identity = { dev: st.dev, ino: st.ino };
  } catch (e) {
    debug(`pii-guard 跨进程槽位目录不可用，只用进程内限流：${String((e as Error)?.message ?? e)}`);
    return undefined;
  }
  hookExit();
  const file = (i: number): string => path.join(opts.dir, `slot-${i}`);
  let broken = false;

  /** 目录仍是打开时的那个真实目录（lstat：符号链接、换目录、换类型都不通过）。 */
  const dirOk = (): boolean => {
    try {
      const st = fs.lstatSync(opts.dir);
      return st.isDirectory() && st.dev === identity.dev && st.ino === identity.ino;
    } catch {
      return false;
    }
  };
  const checkDir = (): void => {
    if (!dirOk()) throw new Error("槽位目录已被替换（身份与打开时不一致）");
  };

  /** 槽位 i 是否过期；是则尝试回收（删之前复核内容没变）。 */
  function reclaim(i: number): void {
    const f = file(i);
    let text: string;
    let age: number;
    checkDir();
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
    const future = age < -FUTURE_SLACK_MS; // mtime 在未来：伪造或时钟异常，不信
    const stale = future || (parsed ? !pidAlive(pid) || age > STALE_MS : age > UNREADABLE_STALE_MS);
    if (!stale) return;
    checkDir();
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
    checkDir();
    try {
      fd = fs.openSync(f, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      reclaim(i);
      checkDir();
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
    held.set(f, { token, dirOk });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (held.get(f)?.token === token) held.delete(f);
      if (dirOk()) removeIfOwner(f, token); // 目录被换了就不碰（也不会删到目录外的文件）
    };
  }

  return {
    background: bg,
    async acquire(background: boolean): Promise<() => void> {
      if (broken) return noop;
      // 前台先试后台用不到的槽位，再试后台也能用的；后台只试前 bg 个。
      const order: number[] = [];
      if (!background) for (let i = bg; i < total; i++) order.push(i);
      for (let i = 0; i < bg; i++) order.push(i);
      const [min, max] = background ? BACKGROUND_POLL_MS : FOREGROUND_POLL_MS;
      let wait: number = min;
      const maxWait = (background ? opts.maxWaitMs?.background : opts.maxWaitMs?.foreground) ?? (background ? BACKGROUND_MAX_WAIT_MS : FOREGROUND_MAX_WAIT_MS);
      const deadline = Date.now() + maxWait;
      try {
        for (;;) {
          for (const i of order) {
            const release = tryTake(i);
            if (release) return release;
          }
          const left = deadline - Date.now();
          if (left <= 0) {
            debug(`pii-guard 等跨进程槽位超过 ${maxWait} ms，本次不取槽位直接推理`);
            return noop;
          }
          await sleep(Math.min(left, wait * (0.5 + Math.random()))); // 抖动，避免多个进程同步重试
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
