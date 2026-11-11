// Tern 状态文件：omp 在 Tern 终端里运行时，把当前交互会话的 PII 保护状态写成 <数据目录>/tern/<TERN_PANE>.json，
// 供 tern-plugin/ 里的 Tern 插件读出并在底栏显示。不在 Tern 里（没有 TERN_PANE）时什么都不写。
//
// 文件内容（版本 1）只含开关、模型状态类别、各类别已遮挡的不同值个数、已检查请求数、失败数，以及与 /pii 相同的一行摘要；
// 不含任何原值、占位符、会话内容。摘要里只有计数与模型加载失败的原因文本（与 /pii 一致，来自本机路径与错误信息，不含请求内容）。
// 字段变了要同步 tern-plugin/window.luau、README 与 AGENTS.md。
//
// 写入：先校验状态目录（lstat：真实目录、不是符号链接、属主是当前用户，权限收紧到 0700，做不到就放弃本次写入），
// 再在同目录用随机名 + 排他创建（wx，0600）写临时文件，rename 过去；变化后 DELAY_MS 内合并写一次；内容没变不重写。
// 删除：会话关闭、扩展卸载（dispose）、进程正常退出（exit）时，只删“本实例写过、且文件里 pid 就是自己”的状态文件
// （同一窗格里没认领的进程，如 `omp -p`，退出时不会删掉交互 omp 的文件）；被杀掉的进程留下的文件由插件按 pid 存活判断忽略，
// 也由之后任何一个写文件的进程顺手清掉（只清 pid 已不存在的普通文件）。所有失败都吞掉，只记 debug：状态显示不能影响遮挡。

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Kind } from "./types.ts";

export const TERN_STATE_VERSION = 1;
/** 变化后合并写的等待时间（毫秒）。 */
export const TERN_WRITE_DELAY_MS = 500;

export type TernModelState = "ready" | "loading" | "setup" | "unavailable" | "idle";

/** 状态文件里由调用方给出的部分（其余 v、pid、pane、updatedAt 由写入方补）。 */
export interface TernBody {
  /** PII 保护是否开启（OMP_PII_GUARD=off 或 /pii off 时为 false）。 */
  on: boolean;
  /** 关闭的原因：env = 环境变量，user = /pii off；开启时没有。 */
  off?: "env" | "user";
  model: {
    /** ready 就绪；loading 加载中；setup /pii setup 进行中；unavailable 不可用；idle 还没加载（首次请求时加载）。 */
    state: TernModelState;
    /** unavailable 时的原因类别：files = 模型文件缺失或校验失败，other = 其他加载错误。 */
    reason?: "files" | "other";
  };
  /** 各类别本会话已遮挡的不同值个数。 */
  kinds: Record<Kind, number>;
  /** 已检查的请求数（与 /pii 同口径）。 */
  requests: number;
  /** 处理失败（请求未发出）的次数。 */
  failed: number;
  /** warning：模型不可用、有失败或网络层未就位；其余为 info。 */
  level: "info" | "warning";
  /** 与 /pii 相同的单行中文摘要。 */
  summary: string;
  /** 列表快捷键对本扩展可用（已注册且没有别的绑定占着它）：插件只在它为 true 时向窗格发快捷键，否则提示用 /pii list。 */
  list: boolean;
}

export interface TernFile extends TernBody {
  v: number;
  pid: number;
  pane: number;
  /** 写入时间（毫秒时间戳）。 */
  updatedAt: number;
}

/** TERN_PANE 必须是正整数，否则视为不在 Tern 里（它会成为文件名的一部分）。 */
export function ternPane(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const v = env.TERN_PANE;
  if (typeof v !== "string" || !/^[1-9]\d{0,15}$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但不归我们
  }
}

export class TernWriter {
  /** 变化后合并写的等待（毫秒）；测试里可调小。 */
  delayMs = TERN_WRITE_DELAY_MS;
  /** 写入失败等的调试输出（扩展工厂里接到 pi.logger.debug）。 */
  debug: (msg: string) => void = () => {};
  /** 成功写出文件的次数（测试用）。 */
  writes = 0;
  readonly file: string;
  private owner: object | undefined;
  private source: (() => TernBody) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 上次写出的内容（不含 updatedAt）；文件被删除后清空，以便重写。 */
  private last: string | undefined;
  /** 本实例是否写出过（且还没删）文件：没写过的实例不删文件。 */
  private wrote = false;
  private swept = false;
  private readonly onExit = (): void => this.removeFile();

  constructor(
    private readonly dir: string,
    readonly pane: number,
    readonly pid: number = process.pid,
  ) {
    this.file = path.join(dir, `${pane}.json`);
    process.on("exit", this.onExit);
  }

  /** 让 owner 的会话成为被显示的会话（后到者为准）。 */
  claim(owner: object, source: () => TernBody): void {
    this.owner = owner;
    this.source = source;
    this.touch();
  }

  /** owner 的会话关闭：它仍是被显示的会话时删文件（换了会话则不动）。 */
  release(owner: object): void {
    if (this.owner !== owner) return;
    this.owner = undefined;
    this.source = undefined;
    this.cancel();
    this.removeFile();
  }

  /** 状态可能变了：合并后写一次。 */
  touch(): void {
    if (!this.source || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** 有一次合并写还没执行（测试等写完用）。 */
  get pending(): boolean {
    return this.timer !== undefined;
  }

  /** 立即写（内容没变则不写）。测试用；touch 的定时器也走这里。 */
  flush(): void {
    try {
      const src = this.source;
      if (!src) return;
      const body = src();
      const key = JSON.stringify(body);
      if (key === this.last) return;
      this.ensureDir();
      if (!this.swept) {
        this.swept = true;
        this.sweepStale();
      }
      const file: TernFile = { v: TERN_STATE_VERSION, pid: this.pid, pane: this.pane, ...body, updatedAt: Date.now() };
      const tmp = `${this.file}.${this.pid}.${randomBytes(6).toString("hex")}.tmp`;
      let fd: number | undefined;
      let created = false;
      try {
        fd = fs.openSync(tmp, "wx", 0o600); // 排他创建：已存在的文件或符号链接一律拒绝
        created = true;
        fs.writeSync(fd, JSON.stringify(file));
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, this.file);
      } catch (e) {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
        if (created) {
          try {
            fs.unlinkSync(tmp); // 只删自己刚建的临时文件
          } catch {}
        }
        throw e;
      }
      this.wrote = true;
      this.last = key;
      this.writes++;
    } catch (e) {
      this.debug(`pii-guard Tern 状态文件写入失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  /** 取消待写、删文件、摘掉 exit 监听。 */
  dispose(): void {
    this.owner = undefined;
    this.source = undefined;
    this.cancel();
    process.off("exit", this.onExit);
    this.removeFile();
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 删状态文件：只在本实例写过、且文件里的 pid 是自己时删（别的进程的文件、没写过的实例都不动）。 */
  private removeFile(): void {
    this.last = undefined;
    if (!this.wrote) return;
    this.wrote = false;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const pid = parsed !== null && typeof parsed === "object" && "pid" in parsed ? parsed.pid : undefined;
      if (pid === this.pid) fs.unlinkSync(this.file);
    } catch {}
  }

  /**
   * 状态目录必须是我们自己的真实目录：lstat 不跟随符号链接，属主是当前用户，权限收紧到 0700。
   * 不满足就抛错（本次不写）：别人预先放的符号链接或目录会把状态文件引到别处，或让别的用户读写。
   */
  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(this.dir);
    if (!st.isDirectory()) throw new Error("状态目录不是真实目录（符号链接或其他类型）");
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new Error("状态目录的属主不是当前用户");
    if ((st.mode & 0o777) !== 0o700) {
      fs.chmodSync(this.dir, 0o700);
      if ((fs.lstatSync(this.dir).mode & 0o777) !== 0o700) throw new Error("状态目录权限无法收紧到 0700");
    }
  }

  /** 清掉本目录里 pid 已不存在的状态文件（被杀掉的 omp 留下的）。不碰别的文件，也不碰 pid 活着的。 */
  private sweepStale(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!/^[1-9]\d*\.json$/.test(n)) continue;
      const f = path.join(this.dir, n);
      if (f === this.file) continue;
      try {
        if (!fs.lstatSync(f).isFile()) continue; // 符号链接、目录不碰
        const parsed: unknown = JSON.parse(fs.readFileSync(f, "utf8"));
        const pid = parsed !== null && typeof parsed === "object" && "pid" in parsed ? parsed.pid : undefined;
        if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) fs.unlinkSync(f);
      } catch {}
    }
  }
}
