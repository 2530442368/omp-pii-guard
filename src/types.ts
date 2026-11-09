// 误报过滤层对外的类型。偏移一律是 JS 字符串下标（UTF-16 码元）。

export type Kind = "PERSON" | "ADDRESS" | "PHONE" | "EMAIL" | "ACCOUNT" | "SECRET";

/** 模型原始结果：UTF-16 下标，label 是 AstrLink Guard 的标签名。 */
export interface RawFind {
  start: number;
  end: number;
  label: string;
  score: number;
}

export interface Span {
  start: number;
  end: number;
  kind: Kind;
}

export interface ModelOptions {
  /** 文本是否为工具调用参数（magpie `Options.args`）：参数里的单词人名不按“应用名”放行。 */
  args: boolean;
  /** 模型分数低于它的结果丢弃（magpie 在 masking 层做，这里一并做）。 */
  threshold: number;
  /** 启用的类别；不在其中的类别不遮。 */
  kinds: ReadonlySet<Kind>;
  /** 永不遮的整值（去首尾空白后与结果整体相等，不分大小写，同 magpie `Options.Allow`）。 */
  allow: ReadonlySet<string>;
  /**
   * 模型自己能找中文人名时为 true（magpie 对 AstrLink Guard 的值，默认）：此时只靠上下文词补找
   * 昵称（小王、老李）。设为 false 时按完整线索（客户/我叫/…先生）补找，仅供测试 magpie 原用例。
   */
  namesByModel?: boolean;
}
