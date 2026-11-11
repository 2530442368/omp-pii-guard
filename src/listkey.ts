// 列表快捷键的“被占用”标记文件（<数据目录>/list-key-taken）：别的绑定占着快捷键时由 pii-guard 写入，存在时启动不注册它。
// 标记只是个开关，内容不重要；但路径在可写的数据目录里，所以读写都不能被符号链接引到别处：
//   - 判断存在用 lstat（不跟随链接）：只有普通文件才算标记；符号链接、目录一律视为异常、当作没有标记；
//   - 写入沿用 Tern 状态文件的做法：校验数据目录是属主为当前用户的真实目录、随机名 wx 0600 临时文件 + rename（替换的是目录项本身，
//     悬空链接不会被写穿）；
//   - 清除只 unlink 目录项本身（链接就删链接，不碰指向的地方），目录不动。

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteNew, ensureOwnDir } from "./tern.ts";

export type MarkerState = "absent" | "file" | "odd";

/** absent = 什么都没有；file = 普通文件（有效标记）；odd = 符号链接、目录等异常物（视为没有标记，应被清掉）。 */
export function markerState(file: string): MarkerState {
  try {
    return fs.lstatSync(file).isFile() ? "file" : "odd";
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "odd";
  }
}

const MARKER_TEXT = "别的绑定占着列表快捷键时由 pii-guard 写入：存在时启动不注册它；快捷键空闲后启动时自动删除。\n";

/** 写标记（失败抛错：数据目录不是自己的真实目录、不可写等）。 */
export function writeMarker(file: string): void {
  ensureOwnDir(path.dirname(file));
  atomicWriteNew(file, MARKER_TEXT);
}

/** 清标记：普通文件或符号链接都只删目录项本身；目录、不存在的不动。 */
export function clearMarker(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (!st.isDirectory()) fs.unlinkSync(file);
}
