// 配置与路径。全部来自环境变量与可选的 config.json；读不出来的字段回落默认并记入 warnings。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Kind } from "./types.ts";

export const ALL_KINDS: readonly Kind[] = ["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT", "SECRET"];

export interface Config {
  /** 模型分数阈值（magpie MinScore，默认 0.8）。 */
  threshold: number;
  /** ONNX Runtime 的线程数。 */
  threads: number;
  /** 启用的类别。 */
  kinds: Set<Kind>;
  /** 永不遮的整值（修误报）。 */
  allow: Set<string>;
  /** 追加的“不还原参数”的工具名（通配，* 匹配任意串）。优先于 restoreTools。 */
  noRestoreTools: string[];
  /** 放行还原的工具名（通配）：mcp__* 工具默认不还原（参数会发往外部服务），本地 MCP 在这里放行。 */
  restoreTools: string[];
  /** 读配置时的告警（字段非法、JSON 解析失败等）。 */
  warnings: string[];
}

export interface Paths {
  root: string;
  modelDir: string;
  keyFile: string;
  configFile: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const root = env.PII_GUARD_DIR || path.join(os.homedir(), ".omp", "agent", "pii-guard");
  return {
    root,
    modelDir: env.PII_GUARD_MODEL_DIR || path.join(root, "model"),
    keyFile: path.join(root, "key"),
    configFile: path.join(root, "config.json"),
  };
}

export function defaultThreads(cores: number = os.availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

export function defaultConfig(): Config {
  return {
    threshold: 0.8,
    threads: defaultThreads(),
    kinds: new Set(ALL_KINDS),
    allow: new Set(),
    noRestoreTools: [],
    restoreTools: [],
    warnings: [],
  };
}

/** OMP_PII_GUARD=off（也认 0/false/disabled）：全局关闭。 */
export function envDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OMP_PII_GUARD ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "disabled";
}

/** PII_GUARD_NO_RESTORE=1：测试开关，关闭所有还原。 */
export function envNoRestore(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PII_GUARD_NO_RESTORE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** 解析 config.json 的内容（已 JSON.parse）。 */
export function parseConfig(raw: unknown): Config {
  const cfg = defaultConfig();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    cfg.warnings.push("config.json 顶层必须是对象，已忽略");
    return cfg;
  }
  const o = raw as Record<string, unknown>;
  const known = new Set(["threshold", "threads", "kinds", "allow", "noRestoreTools", "restoreTools"]);
  for (const k of Object.keys(o)) if (!known.has(k)) cfg.warnings.push(`config.json 未知字段 ${k}，已忽略`);

  if (o.threshold !== undefined) {
    if (typeof o.threshold === "number" && o.threshold >= 0.5 && o.threshold <= 1) cfg.threshold = o.threshold;
    else cfg.warnings.push("threshold 必须是 0.5–1 之间的数字，已用默认 0.8");
  }
  if (o.threads !== undefined) {
    if (typeof o.threads === "number" && Number.isInteger(o.threads) && o.threads >= 1 && o.threads <= 64) cfg.threads = o.threads;
    else cfg.warnings.push("threads 必须是 1–64 的整数，已用默认值");
  }
  if (o.kinds !== undefined) {
    if (Array.isArray(o.kinds) && o.kinds.every((k) => typeof k === "string" && (ALL_KINDS as readonly string[]).includes(k.toUpperCase()))) {
      cfg.kinds = new Set(o.kinds.map((k: string) => k.toUpperCase() as Kind));
    } else cfg.warnings.push(`kinds 必须是 ${ALL_KINDS.join("/")} 的数组，已启用全部类别`);
  }
  const strings = (name: "allow" | "noRestoreTools" | "restoreTools"): string[] | undefined => {
    const v = o[name];
    if (v === undefined) return undefined;
    if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v as string[];
    cfg.warnings.push(`${name} 必须是字符串数组，已忽略`);
    return undefined;
  };
  const allow = strings("allow");
  if (allow) cfg.allow = new Set(allow);
  const nrt = strings("noRestoreTools");
  if (nrt) cfg.noRestoreTools = nrt;
  const rt = strings("restoreTools");
  if (rt) cfg.restoreTools = rt;
  return cfg;
}

/** 读 config.json；文件不存在是正常的（返回默认）；解析失败回落默认并告警。 */
export function loadConfig(file: string = paths().configFile): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    const cfg = defaultConfig();
    cfg.warnings.push(`读取 ${file} 失败：${String(e)}`);
    return cfg;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const cfg = defaultConfig();
    cfg.warnings.push(`${file} 不是合法 JSON：${String(e)}，已用默认配置`);
    return cfg;
  }
  return parseConfig(raw);
}
