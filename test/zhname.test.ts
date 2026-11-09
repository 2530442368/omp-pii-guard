// 移植自 magpie internal/redact/zhname_test.go（含 zhword_known_test.go 里与模型过滤有关的部分）。
// magpie 的 TestChineseNames 等没设 NamesByModel（按“完整线索”补找中文名），对应这里的 namesByModel: false；
// TestChineseNamesByModelOnlyNicks 用默认值（true，AstrLink Guard 的值）。

import { describe, expect, test } from "bun:test";
import { zhTrim } from "../src/zhname.ts";
import { modelSpans, type Kind } from "../src/filters.ts";
import { covered, fakeFind, mask, opts, spansOf } from "./helpers.ts";

const PERSONAL: ReadonlySet<Kind> = new Set<Kind>(["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT"]);
const full = { kinds: PERSONAL, namesByModel: false };

const modelSaid: Record<string, string> = {
  "王芳，她下周一": "private_person",
  刘洋: "private_person",
  赵丽颖: "private_person",
  欧阳娜娜: "private_person",
  司马光: "private_person",
  张伟先生: "private_person",
  周杰伦: "private_person",
  田中太郎: "private_person",
  // 模型可能这样：隔开的名字、姓加称谓
  "张 伟": "private_person",
  李老师: "private_person",
};

describe("TestChineseNames", () => {
  const cases: { s: string; names: string[]; keep: string[] }[] = [
    { s: "帮我写封信给张伟，他住在北京市朝阳区建国路88号", names: ["张伟"], keep: ["，他住在"] },
    { s: "请把合同发给王芳，她下周一到上海。", names: ["王芳"], keep: ["，她下周一到上海"] },
    { s: "李娜和刘洋昨天开会讨论了项目进度。", names: ["李娜", "刘洋"], keep: ["和", "昨天开会"] },
    { s: "客户陈建国反馈导出功能在他电脑上失败了。", names: ["陈建国"], keep: ["反馈导出"] },
    { s: "客户张三反馈导出失败", names: ["张三"], keep: ["反馈"] },
    { s: "联系人：赵丽颖，手机", names: ["赵丽颖"], keep: [] },
    { s: "提交者是欧阳娜娜，审核人是司马光。", names: ["欧阳娜娜", "司马光"], keep: ["审核人是"] },
    { s: "张伟先生，您好！感谢您的来信。", names: ["张伟"], keep: ["先生，您好"] },
    { s: "我叫黄晓明，是这个仓库的维护者。", names: ["黄晓明"], keep: ["我叫"] },
    { s: "// author: 周杰伦", names: ["周杰伦"], keep: [] },
    { s: "给小王发个消息，说老李明天不来了。", names: ["小王", "老李"], keep: ["发个消息", "明天不来了"] },
    { s: "马云说过，今天很残酷。", names: ["马云"], keep: ["说过"] },
    { s: "田中太郎さんに連絡してください。", names: ["田中太郎"], keep: [] },
    { s: "转交张 伟处理", names: ["张 伟", "伟"], keep: [] },
    { s: "感谢李老师的帮助", names: ["李老师", "李"], keep: [] },
    // 下面这些都不是名字
    { s: "这个函数的作用是把高度转换成像素。", names: [], keep: ["高度"] },
    { s: "王国的军队在黄河边扎营。", names: [], keep: ["王国", "黄河"] },
    { s: "我们需要一个更高效的排序算法。", names: [], keep: ["高效"] },
    { s: "请帮我修复这个 bug，张开的括号没有闭合。", names: [], keep: ["张开"] },
    { s: "给张量赋值之前先检查形状。", names: [], keep: ["张量"] },
    { s: "在建国路上，路边有一家店。", names: [], keep: ["建国路", "路边"] },
    { s: "把方法和文件名都改一下", names: [], keep: ["方法", "文件"] },
    { s: "给老师发个消息", names: [], keep: ["老师"] },
    { s: "王老板说这个需求下周要上线，邓总明天要来看演示。", names: ["王老板", "邓总"], keep: ["明天要来"] },
    { s: "请帮我回复一下孙经理的邮件", names: ["孙经理"], keep: ["的邮件"] },
    { s: "抄送给吴敏和郑浩。", names: ["吴敏", "郑浩"], keep: [] },
    { s: "负责人：许文强", names: ["许文强"], keep: [] },
    { s: "我是郭靖，想咨询一下退款的问题。", names: ["郭靖"], keep: ["想咨询"] },
    { s: "和平时一样，周五发版。", names: [], keep: ["周五", "和平"] },
    { s: "方总结一下：说明文档里要写清楚安装步骤。", names: [], keep: ["方总结", "说明"] },
    { s: "运行测试的时候，内存一直在涨。签名和工具调用都会保留。", names: [], keep: ["签名和工具"] },
    // xuanwo on X：报告里的词，被遮成 关键、易触、边界
    { s: "### 关键发现：5 组 bot/人类重复 PR", names: [], keep: ["关键发现"] },
    { s: "`gh pr view` 易触发 GraphQL rate limit", names: [], keep: ["易触发"] },
    { s: "\n\n先读判断和边界，仅当来源", names: [], keep: ["和边界，"] },
    { s: "打开文件之前，边界检查失败。", names: [], keep: ["边界检查"] },
    // 同样的线索旁边的名字仍是名字
    { s: "### 张伟发了个消息", names: ["张伟"], keep: ["发了个消息"] },
    { s: "我和张伟，还有他。", names: ["张伟"], keep: ["我和"] },
    { s: "这件事。 李娜说过。", names: ["李娜"], keep: ["说过"] },
    // zeewell on X：文案（文是姓）被遮成名字；各句里的线索：前面的“一下”、句首后面的已经/明天/他们、说明的“说”
    { s: "帮我改一下这段文案", names: [], keep: ["文案"] },
    { s: "润色一下文案。", names: [], keep: ["文案"] },
    { s: "检查一下文案，看看有没有错别字", names: [], keep: ["文案"] },
    { s: "文案：首页标题换成「更快的网关」", names: [], keep: ["文案"] },
    { s: "把首页文案换成英文", names: [], keep: ["文案"] },
    { s: "### 文案\n\n- 文案和图片都要改", names: [], keep: ["文案"] },
    { s: "文案已经改好了，你再看看。", names: [], keep: ["文案"] },
    { s: "文案明天给你，图片今天先发。", names: [], keep: ["文案"] },
    { s: "文案说明要简短，不超过两行。", names: [], keep: ["文案说明"] },
    { s: "文案他们说下午定稿", names: [], keep: ["文案他们"] },
    { s: "这张图发给文案。", names: [], keep: ["文案"] },
    // 同样位置的名字仍是名字
    { s: "问一下张伟，这段谁来写", names: ["张伟"], keep: ["问一下"] },
    { s: "张伟说明天来改。", names: ["张伟"], keep: ["说明天"] },
    { s: "客户张伟已经到了。", names: ["张伟"], keep: ["已经到了"] },
    { s: "这张图发给张伟。", names: ["张伟"], keep: ["发给"] },
  ];
  for (const c of cases) {
    test(c.s.replace(/\n/g, "⏎"), () => {
      const out = mask(c.s, spansOf(c.s, modelSaid, full));
      for (const n of c.names) expect(out.includes(n)).toBe(false);
      for (const k of c.keep) expect(out.includes(k)).toBe(true);
    });
  }
});

describe("TestChineseWordsAreNoNames", () => {
  const words = ["文案", "文档", "文风", "方案", "高度", "安全", "马上", "程序", "林间", "关键", "项目", "成本", "段落", "颜色", "查询", "时区", "季度", "边框", "简历", "游戏", "严格", "曾经", "谢谢", "解析", "付费"];
  const shapes = ["改一下%s", "检查一下%s。", "%s已经好了", "%s明天给你", "%s说明", "%s他们定", "请%s", "发给%s", "%s：", "把%s换成英文"];
  for (const w of words) {
    test(`词 ${w}`, () => {
      for (const sh of shapes) {
        const s = sh.replaceAll("%s", w);
        expect(spansOf(s, {}, full)).toEqual([]);
      }
      // 模型自己给的 PERSON 标签落在整个词上
      const s = `帮我改一下这段${w}，谢谢`;
      expect(fakeFind(s, { [w]: "private_person" }).length).toBeGreaterThan(0);
      expect(spansOf(s, { [w]: "private_person" }, full)).toEqual([]);
    });
  }
  // zhWords 里没有的词只靠线索放行，但前面有人的动词的除外（请文创、发给文创）
  for (const w of ["文创", "方位", "高铁", "安防", "林荫"]) {
    test(`线索放行 ${w}`, () => {
      for (const sh of shapes.slice(0, 6)) {
        const s = sh.replaceAll("%s", w);
        expect(spansOf(s, {}, full)).toEqual([]);
      }
    });
  }
});

describe("TestChineseNamesNeedModel", () => {
  test("个人信息关掉，不找中文名", () => {
    const s = "客户钟离秋反馈导出失败";
    expect(spansOf(s, {}, { kinds: new Set<Kind>(["SECRET"]), namesByModel: false })).toEqual([]);
    expect(covered(s, spansOf(s, {}, full))).toEqual(["钟离秋"]);
  });
});

describe("TestMaoliIsAMargin", () => {
  test("毛利是毛利率的毛利，不是人", () => {
    for (const s of ["毛利低", "毛利低说", "我是毛利低", "这个产品毛利低说明定价有问题", "我是毛利低的那个品类负责人", "毛利低说明成本高", "告诉毛利低的门店先别补货", "毛利率下降了", "毛利额是多少", "看一下毛利润"]) {
      expect(spansOf(s, {}, full)).toEqual([]);
    }
    const s = "毛利小五郎姓什么";
    expect(covered(s, spansOf(s, { 毛利小五郎: "private_person" }, full))).toEqual(["毛利小五郎"]);
  });
});

describe("TestChineseNamesByModelOnlyNicks（默认：AstrLink Guard 自己找名字）", () => {
  const values = { 龚秋实: "private_person" };
  for (const c of [
    { s: "小邵说他明天到", masked: "小邵", kept: "说他明天到" },
    { s: "客户龚秋实和小邵反馈导出失败", masked: "龚秋实和小邵", kept: "反馈导出失败" },
    { s: "客户钟离夏反馈导出失败", masked: "", kept: "钟离夏" },
    { s: "## 关键发现", masked: "", kept: "关键发现" },
  ]) {
    test(c.s, () => {
      const out = mask(c.s, spansOf(c.s, values, { kinds: PERSONAL }));
      if (c.masked) expect(out.includes(c.masked)).toBe(false);
      expect(out.includes(c.kept)).toBe(true);
    });
  }
});

describe("TestModelWordsAreNoNames", () => {
  const words = ["黄绿色", "黄绿", "红色", "金黄色", "浅蓝色", "蓝绿色", "关键词", "关键字", "关键点", "边界", "边界线", "边距", "应用层", "应该", "尚可", "尚无", "毛利率", "温度计", "程序员", "文件名", "时间戳", "关心", "包括", "管理", "连接"];
  const shapes = ["%s", "把按钮改成%s", "提取这段文本的%s", "帮我改一下这段%s，谢谢", "%s已经好了", "%s说明", "请%s", "发给%s。", "检查一下%s。", "张伟和%s", "%s：首页"];
  for (const w of words) {
    test(`词 ${w}`, () => {
      for (const sh of shapes) {
        const s = sh.replaceAll("%s", w);
        for (const said of [{}, { [w]: "private_person" }]) {
          const got = covered(s, spansOf(s, said, full));
          // “张伟和…”里的 张伟 是名字，被遮是对的；词本身不能被遮
          expect(got.every((g) => g === "张伟" && sh.includes("张伟"))).toBe(true);
        }
      }
    });
  }
});

describe("TestModelNamesBesideWords", () => {
  const values = Object.fromEntries(["黄晓明", "关羽", "毛利兰", "方圆", "高歌", "江山", "黄蓉"].map((n) => [n, "private_person"]));
  for (const [s, name] of [
    ["我叫黄晓明，衣服是黄绿色的", "黄晓明"],
    ["关羽的关键词是忠义", "关羽"],
    ["毛利兰的毛利率", "毛利兰"],
    ["黄蓉穿着红色的衣服", "黄蓉"],
    ["客户方圆反馈导出失败", "方圆"],
    ["联系人：高歌", "高歌"],
    ["感谢江山老师的帮助", "江山"],
  ] as const) {
    test(s, () => {
      const out = mask(s, spansOf(s, values, full));
      expect(out.includes(name)).toBe(false);
      for (const w of ["黄绿色", "关键词", "毛利率", "红色"]) if (s.includes(w)) expect(out.includes(w)).toBe(true);
    });
  }
  test("没有人指的时候，词就是词", () => {
    for (const s of ["天下方圆百里", "江山如画"]) expect(spansOf(s, values, full)).toEqual([]);
  });
});

describe("zhword_known_test.go：TestKnownWordTakenForANameGoesAsWritten 的模型部分", () => {
  test("白名单：模型的结果按词放行，不会成为已知值", () => {
    const s = "开启白名单之后，把要放行的域名填进去。";
    expect(fakeFind(s, { 白名单: "private_person" }).length).toBe(1);
    expect(spansOf(s, { 白名单: "private_person" }, full)).toEqual([]);
    expect(spansOf("设置里的白名单要加一行。", { 白名单: "private_person" }, full)).toEqual([]);
  });
  test("角色词说是人的地方，白名单照遮", () => {
    const s = "联系人：白名单，电话见附件";
    expect(covered(s, spansOf(s, { 白名单: "private_person" }, full))).toEqual(["白名单"]);
  });
  test("自己的名字：客户欧阳娜娜", () => {
    const s = "客户欧阳娜娜来电话";
    expect(covered(s, spansOf(s, { 欧阳娜娜: "private_person" }, full))).toEqual(["欧阳娜娜"]);
  });
});

describe("zhTrim", () => {
  test("在汉字之后的第一个标点处截断；称谓处截断；四字名保持", () => {
    const t = (s: string, a = 0, b = s.length): string => {
      const [x, y] = zhTrim(s, a, b);
      return s.slice(x, y);
    };
    expect(t("王芳，她下周一")).toBe("王芳");
    expect(t("张伟先生")).toBe("张伟");
    expect(t("林黛玉进贾府")).toBe("林黛玉进贾府");
    expect(t("田中太郎")).toBe("田中太郎");
    expect(t("李老师")).toBe("李老师"); // 称谓前不足两个字不截
    expect(t("Rina Kowalczyk")).toBe("Rina Kowalczyk");
    expect(t("乔·布朗，说")).toBe("乔·布朗");
    expect(t("张伟，她", 0, 5)).toBe("张伟");
  });
});

describe("modelSpans 的 PERSON 修边", () => {
  test("模型的区间连带吃进的话被去掉（王芳，她下周一）", () => {
    const s = "请把合同发给王芳，她下周一到上海。";
    const sp = modelSpans(s, fakeFind(s, { "王芳，她下周一": "private_person" }), opts({ kinds: PERSONAL, namesByModel: false }));
    expect(covered(s, sp)).toEqual(["王芳"]);
  });
  test("张伟先生 → 张伟", () => {
    const s = "张伟先生，您好！";
    expect(covered(s, spansOf(s, { 张伟先生: "private_person" }, full))).toEqual(["张伟"]);
  });
});
