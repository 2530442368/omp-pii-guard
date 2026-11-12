// test/slots.test.ts 的子进程：真实的跨进程争用。不是测试文件（不以 .test.ts 结尾），由测试用 spawn 启动。
// 环境：SLOTS_DIR、SLOTS_TOTAL、SLOTS_BG、WORKER_MODE（contend | hold | exit-held）、HOLD_DIR（并发计数目录）。
// contend：反复 取槽位 → 在 HOLD_DIR 里登记 → 数同时登记的数量（总数、后台数）→ 睡一会 → 取消登记 → 放槽位；最后输出 JSON。
// hold：取一个槽位后输出 "held" 并一直睡（测试对它 kill -9）。
// exit-held：取一个槽位后输出 "held"，不释放直接 process.exit(0)。

import * as fs from "node:fs";
import * as path from "node:path";
import { openGlobalSlots } from "../src/slots.ts";

const slots = openGlobalSlots({
  dir: process.env.SLOTS_DIR!,
  total: Number(process.env.SLOTS_TOTAL),
  background: Number(process.env.SLOTS_BG),
});
if (!slots) {
  console.log(JSON.stringify({ error: "openGlobalSlots 返回 undefined" }));
  process.exit(1);
}
const mode = process.env.WORKER_MODE ?? "contend";
const background = process.env.WORKER_BG === "1";

if (mode === "hold") {
  await slots.acquire(background);
  console.log("held");
  await new Promise(() => {}); // 等被 kill
} else if (mode === "exit-held") {
  await slots.acquire(background);
  console.log("held");
  process.exit(0);
} else {
  const holdDir = process.env.HOLD_DIR!;
  const iterations = Number(process.env.ITERATIONS ?? 10);
  let maxTotal = 0;
  let maxBg = 0;
  for (let n = 0; n < iterations; n++) {
    const release = await slots.acquire(background);
    const mine = path.join(holdDir, `${process.pid}-${n}.${background ? "bg" : "fg"}`);
    fs.writeFileSync(mine, "");
    const names = fs.readdirSync(holdDir);
    maxTotal = Math.max(maxTotal, names.length);
    maxBg = Math.max(maxBg, names.filter((x) => x.endsWith(".bg")).length);
    await new Promise((r) => setTimeout(r, 8));
    fs.unlinkSync(mine); // 先撤登记再放槽位
    release();
  }
  console.log(JSON.stringify({ maxTotal, maxBg, iterations }));
}
