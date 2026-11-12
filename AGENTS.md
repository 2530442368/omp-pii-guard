# omp-pii-guard 项目协作规范

**改任何代码前先读完本文件。** 这是一个公开仓库的 omp 扩展：改坏它的后果是“个人信息被原样发往模型服务”，所以下面第 5 节的约束比一般项目更硬。用户向的说明在 [README.zh-CN.md](README.zh-CN.md) / [README.md](README.md)，本文件只讲怎么安全地改代码，不复述 README。

本文件作用域为整个仓库。

## 1. 项目概述与作用域

- 一个 [omp](https://github.com/can1357/oh-my-pi) 扩展：请求发往模型服务之前，用本地 AstrLink Guard 模型（ONNX int8，CPU）识别人名、地址、手机、邮箱、账号、密码六类个人信息，换成 `{{KIND_xxxxxxxx}}` 占位符；回复里的占位符在本机换回原值（可还原遮挡）。
- 入口由 `package.json` 的 `omp.extensions` 声明：`./src/index.ts`（默认导出 `piiGuard(pi)`）。
- 识别后的“是不是误报”过滤规则移植自 [magpie](https://github.com/yetone/magpie)（MIT，声明见 `NOTICE`）；模型本身不进仓库。
- 识别是尽力而为，不是保证；被保证的只有“处理失败的请求不发出”（fail-closed）。文档与注释里不得写成“保证不泄露”。
- 不在范围内：密钥/令牌正则（那是 omp 自带 Hide Secrets 的事）、URL/IP/日期、图片与 PDF、magpie 的自定义遮挡词（README“局限”一节）。

## 2. 技术栈与运行时

| 项 | 说明 |
| --- | --- |
| 语言 | TypeScript（ESM，`"type": "module"`），源码里用 `.ts` 后缀互相导入；注释与用户可见文案为中文 |
| 运行时 | omp 二进制自带的 Bun（扩展在 omp 进程里运行）。没有独立 Bun 时用 `BUN_BE_BUN=1 omp …` 把 omp 当 Bun 用（见第 4 节） |
| 依赖 | 仅两个，且版本钉死：`onnxruntime-node@1.31.1`、`@anush008/tokenizers@0.6.0`（`package.json` + `package-lock.json`）；没有构建步骤，源码直接运行 |
| 原生依赖加载 | `src/guard.ts` 里用动态 `import()` 按需加载，**不得改成静态 import**：没装依赖或没装模型时扩展仍要能加载，`/pii` 与失败提示才可用 |
| 已验证环境 | omp 18.18.x（`src/index.ts` 的 `VERIFIED_VERSION = /^18\.18\./`，版本不符时启动提示）、macOS arm64。其他环境未验证；网络层的实测行为（重试行为、Anthropic 直连走 `ClientRequest` 路径）来自 omp 18.18.1 |
| 模型 | [QuantumNous/astrlink-guard](https://huggingface.co/QuantumNous/astrlink-guard) 固定修订（`src/guard.ts` 的 `MODEL_REVISION`）的 `int8/` 三个文件，默认存到 `~/.omp/agent/pii-guard/model/` |

## 3. 目录与模块地图

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 扩展入口：`/pii` 命令（状态、`list`、`setup`、`on`/`off`）与快捷键 `LIST_KEY`（仅在 `list-key-taken` 标记（`src/listkey.ts`：lstat 判断、只认普通文件；写入走 `ensureOwnDir` + `atomicWriteNew`，不写穿符号链接）不存在时注册，所以首次遇到冲突的那一次启动内可能已覆盖对方的绑定（加载期 `getShortcutConflict` 不可用，已知限制），之后启动不再注册；`checkListKey` 在 `session_start` 里用 `getShortcutConflict` 确认并写入 `Runtime.listKey`，状态文件的 `list` 字段；`ctrl+alt+p`，同样打开原值列表）；挂接事件（`session_start`/`switch`/`branch`/`tree`/`compact`、`before_provider_request`、`tool_call`、`assistant_message`、`input`、`tool_result`）和助手文本渲染器；进程级单例 `Runtime`（`globalThis[Symbol.for("omp-pii-guard.runtime")]`）：`runtime()` 里接线——`Limiter(总槽位, 惰性打开的跨进程槽位)`、`Masker` 的持久缓存（`findCache(rt)`，第一次用到才打开、只开一次）、`rt.debug` 日志出口；预扫描范围由 `sentTexts` 决定（最后一次压缩的摘要 + `firstKeptEntryId` 起的条目；`loadBranch` 与 `noteUsed` 仍用整条分支）；`session_shutdown` 只刷缓存不关闭（关闭由缓存自己的 `exit` 钩子做）；`testHooks` 供测试重置 |
| `src/list-ui.ts` | `/pii list` 的本机界面：`ctx.ui.custom` 里的只读列表组件 `ValueList`（列表/全文两层、滚动、Esc 分层关闭）与 `openValueList`；`visible()` 把控制字符、零宽字符、双向控制字符换成可见转义（`⟨U+202E⟩` 等）。不引用任何 `@oh-my-pi/*` 包，按键由工厂传入的 `keybindings` 判定 |
| `src/listkey.ts` | 列表快捷键的“被占用”标记文件 `<数据目录>/list-key-taken`：`markerState`（lstat，只有普通文件算标记，符号链接与目录视为异常）、`writeMarker`（沿用 `src/tern.ts` 的 `ensureOwnDir` + `atomicWriteNew`，不写穿符号链接）、`clearMarker`（只删目录项本身） |
| `src/config.ts` | 路径（`PII_GUARD_DIR`、`PII_GUARD_MODEL_DIR`）、环境开关（`OMP_PII_GUARD`、`PII_GUARD_NO_RESTORE`）、`config.json` 解析与校验（字段非法回落默认并记 `warnings`） |
| `src/guard.ts` | AstrLink Guard 推理（510 token 窗口、重叠 128、分数下限 0.5；`InferenceSession.create` 带 `extra`：关闭 ORT 线程自旋 `allow_spinning=0`，超订时 CPU 时间约降到三分之一）、`MODEL_FILES`（文件名/大小/sha256）与 `verifyModel`、并发闸门 `Limiter`（进程内名额 + 可选跨进程槽位 `GlobalSlots`；前台排在后台前面）、`Recognizer` 接口（测试换假识别器） |
| `src/setup.ts` | `/pii setup`：已就绪跳过 → 复制本机 magpie 缓存 → 从固定修订下载；临时文件 + 校验 + 原子替换。**扩展里唯一会联网的代码** |
| `src/tern.ts` | Tern 状态文件：`TernWriter`（有 `TERN_PANE` 时把当前交互会话的状态写成 `<数据目录>/tern/<TERN_PANE>.json`：临时文件 + rename、0600、500 ms 去抖、退出/关闭时删除、顺手清 pid 已死的残留）、`TernBody`/`TernFile` 契约类型、`ternPane()`。内容由 `src/index.ts` 的 `status()` 产出（与 `/pii` 同一份数据） |
| `src/mask.ts` | 遮挡管线：推理 → 过滤 → 已知值补遮 → 剪掉与已有占位符相交的部分 → 生成占位符；按文本 sha256 的内存 LRU 缓存，未命中先查持久缓存（`cache` 参数，第 4 个构造参数，惰性取用）再推理，推理完（含超时后后台完成的）写回；`$$…$$` / `{{…}}` 保护 |
| `src/cache.ts` | 持久识别缓存（`bun:sqlite`，WAL）：模型原始结果 `RawFind[]`，键 = `HMAC-SHA256(key, "pii-guard/find-cache/v1\0" + MODEL_REVISION + "\0" + 文本)`，值是位置/标签/分数，另有最近使用日。目录 `<数据目录>/cache/` 经 `ensureOwnDir`（0700）、库与 `-wal`/`-shm` 为 0600；读出的行逐项校验；200 000 条上限按最近使用日淘汰到 90%；写入合并批量（200 条或 3 s）、退出时刷盘；损坏删除重建一次，连续出错禁用；很多进程同时首次创建时打开遇忙/锁带抖动重试。任何错误只表现为“未命中” |
| `src/slots.ts` | 跨进程推理槽位：`<数据目录>/slots/slot-<i>` 文件（`wx` 排他创建、0600，内容 `pid token 时间`），总数 `max(1, 核数/线程)`，后台（预扫描）只能用前 `max(1, 核数/2/线程)` 个；轮询退避加抖动；持有者死亡或文件超过 120 s 视为过期并回收；释放只删自己 token 的文件；退出时同步释放。目录不可用时退回进程内限流 |
| `src/payload.ts` | 请求体遍历：按格式（`anthropic-messages`、`openai-responses`、`openai-codex-responses`、`openai-completions`）收集可改的字符串叶子并就地写回 |
| `src/transport.ts` | 网络层兜底：包装 `globalThis.fetch`、`globalThis.WebSocket`、`http.ClientRequest.prototype.write/end`；已知 LLM origin 判定；不发出时合成 422 / WS error 帧 |
| `src/placeholder.ts` | 占位符生成（HMAC-SHA256）、密钥文件、占位符映射与还原、工具参数还原策略（`restorePolicy`） |
| `src/local.ts` | 扫描本地会话/系统提示里字面出现的 `$$…$$`，判断它是不是 omp 刚生成的占位符 |
| `src/known.ts` | 已知值补遮（字典树；移植自 magpie） |
| `src/filters.ts`、`zhname.ts`、`email.ts`、`packages.ts`、`ids.ts`、`thingname.ts`、`text.ts` | 误报过滤与中文名补找，移植自 magpie（见 `NOTICE`） |
| `src/zhdata.ts`、`src/tlds.ts` | 机械生成的数据表（中文姓氏/词表、ICANN 顶级域），文件头注明来源；不要手工增删条目 |
| `src/types.ts` | `Kind`、`RawFind`、`Span`、`ModelOptions` |
| `test/*.test.ts` | `bun:test` 用例，每个 `src` 模块对应一个或多个文件（`index`、`list`、`transport`、`mask`、`payload`、`placeholder`、`setup`、`filters`、`known`、`zhname`、`email`、`offsets`、`local`、`perf`、`guard`、`tern`、`scope`（预扫描范围）、`cache`（持久缓存，含多进程与同时首次创建）、`slots`（跨进程限流，含真实子进程争用）；`list` 覆盖 `/pii list` 与快捷键）；`helpers.ts`（把 magpie 测试里的 fakeModel 换成 AstrLink 标签）、`fake.ts`（`FakeRecognizer`）、`cache-worker.ts`/`slots-worker.ts`（多进程用例的子进程）是辅助 |
| `tern-plugin/` | 可选的 Tern 底栏插件（`plugin.toml` + `window.luau`，Luau）：读扩展写的状态文件，在焦点窗格的底栏显示可点击的 PII 段（点击 → 向 omp 窗格发快捷键打开原值列表，命令 `plugin.pii-guard.list`；命令 `plugin.pii-guard.details` 仍是弹统计 toast）。不属于 omp 扩展，不随 `scripts/install.sh` 安装；安装 `tern plugin install <本仓库目录>/tern-plugin --force`。没有自动化测试，改动要在 Tern 里实测（见第 6 节）。formatter 只读缓存、不做 I/O（Tern 限制 4 ms） |
| `scripts/install.sh` | 克隆后复制安装：校验并复制模型、复制 `src/` 到 omp 的扩展目录并 `npm ci`；模型只从本机缓存复制、不下载，`npm ci` 在依赖未缓存时会联网；不改 omp 配置 |
| `scripts/bench.ts`、`scripts/bench-restore.ts`、`scripts/bench-corpus.ts` | 基准与固定种子的合成语料生成器；README“性能”一节的数字来自它。`bench-restore.ts` 是 `bench restore`（批量恢复：N 个进程同时启动，各自预扫不同的合成历史，冷/热缓存两轮；`PII_BENCH_SRC` 可指向旧版 src 做基线）|
| `docs/demo/` | README 的演示动图（`demo.*.gif`）、vhs 脚本（`demo.*.tape`）、本地模拟服务端 `mock-server.ts`、重录脚本 `record.sh` |
| `README.md`、`README.zh-CN.md` | 中英两份用户文档，内容必须同步 |
| `NOTICE`、`LICENSE` | 第三方声明、MIT 许可 |

## 4. 常用命令

在仓库根目录执行。没有独立 Bun 时，把 `bun …` 换成 `BUN_BE_BUN=1 omp …`（`omp test` 等价于 `bun test`，`omp run <文件>` 等价于 `bun <文件>`）。

| 目的 | 命令 |
| --- | --- |
| 装依赖（不跑脚本） | `npm ci --ignore-scripts` |
| 全量测试 | `bun test`，或 `BUN_BE_BUN=1 omp test` |
| 单个测试文件 | `BUN_BE_BUN=1 omp test test/transport.test.ts` |
| 基准 | `bun run bench`（全部，约 2 分钟）、`bun run bench speed`、`bun run bench effect`、`bun run bench sweep`（线程扫描，约 10 分钟）、`bun run bench restore`（批量恢复，冷/热缓存各一轮，约 1–3 分钟；机器负载高时数字不可比，要记下当时的 `uptime`）；无 Bun：`BUN_BE_BUN=1 omp run scripts/bench.ts [all\|speed\|effect\|sweep]` |
| 开发时加载扩展 | `omp -e <本仓库目录>`（显式加载；**不要**把仓库代码直接放进 `~/.omp/agent/extensions`，那里会被所有新会话加载） |
| 复制安装 | `scripts/install.sh`；会写入 omp 的 agent 目录（`OMP_AGENT_DIR`，默认 `~/.omp/agent`），仅在用户要求时运行，试跑时用 `OMP_AGENT_DIR`、`PII_GUARD_DIR` 指向临时目录 |
| 在 omp 里准备模型 | 会话里执行 `/pii setup`（只有它会联网）；`/pii` 看状态；`/pii on`、`/pii off` 开关 |
| 安装/更新 Tern 底栏插件 | `tern plugin install <本仓库目录>/tern-plugin --force`；`tern plugin list` 应显示 `pii-guard … ready`；卸载 `tern plugin remove pii-guard`。会改本机 Tern 的插件目录并让 Tern 重载插件，仅在用户要求或实测时执行 |
| 重录演示动图 | `docs/demo/record.sh [zh\|en\|all]` |

说明：

- 测试里的“真模型”用例（`test/guard.test.ts`、`test/index.test.ts` 的 `/pii setup` 里复制缓存的用例）在模型目录不存在时自动跳过；模型目录默认是 magpie 缓存 `~/.cache/magpie/astrlink-guard/7216b6a3b897`，`test/guard.test.ts` 可用 `PII_GUARD_TEST_MODEL_DIR` 覆盖。其余用例用假识别器，不需要模型。耗时断言只放在 `test/perf.test.ts` 的性能回归用例里（已知值补遮 200 ms、人为最坏情形与 `modelSpans` 1000 ms），其他测试不对耗时做断言。
- 基准需要模型：依次找 `PII_GUARD_MODEL_DIR`、`<数据目录>/model`、magpie 缓存，找不到就先 `/pii setup`。其他开关：`THREADS`、`PII_BENCH_RESTORE_PROCS`/`_KB`/`_ROUNDS`/`PII_BENCH_SRC`（restore）、`PII_BENCH_JSON`、`PII_BENCH_SEED`、`PII_BENCH_PER_KIND`、`PII_BENCH_REPS`、`PII_BENCH_DIRS`、`PII_BENCH_SESSIONS`（见 `scripts/bench.ts` 文件头）。
- 重录动图前提：`vhs`、`tmux`、`gifsicle`、omp 18.18.x 二进制（`OMP_BIN`，默认取 PATH 里的 `omp`）、本机已有模型（`PII_GUARD_MODEL_DIR`）、先 `npm ci --ignore-scripts`；`.tape` 里用 Sarasa Mono SC 字体。脚本用临时 HOME 和数据目录，不碰真实的 `~/.omp`。动图是二进制文件，没有这些前提就不要重录，也不要手改 `.tape` 后不重录。

## 5. 不可破坏的约束

改动触及下面任一条，必须在对应测试里证明行为没变（或有意改变并同步文档）。

1. **fail-closed：处理失败的请求一律不发出，不放行原文。** 出口（`before_provider_request`）失败时 `return {}`；网络层对“已知 LLM 服务的推理端点上无法遮挡的体”（无法解码、无法解析、认不出格式、不支持的编码、遮挡出错）不发出。不得为了“让请求通过”加 try/catch 后原样放行。例外只有设计内的两种：出口超时且网络层在位时交给网络层；未知来源上认不出格式的非 LLM 形状体原样放行（见 `src/transport.ts` 文件头）。
2. **不发出的方式必须是合成的不可重试响应，不能是连接错误。** omp 18.18.1 把连接类错误当成可重试，会重试约 10 次、`-p` 150 s 以上不退出。所以：fetch 返回合成 HTTP 422（头 `x-should-retry: false`、JSON 错误体 `code: pii_guard_blocked`）；WebSocket 先投递一帧服务端 `error` 事件（同 code）再以 1000 关闭；`ClientRequest` 产出合成的 422 `IncomingMessage`，不 `destroy` 成连接错误。错误文本是固定的 ASCII 句子（`BLOCKED_MESSAGE`），不含 timeout/connection/server error 之类会被当成瞬时错误的词；具体原因只走界面提示（`deps.fail`）。相关用例：`test/transport.test.ts`“不发出时的失败方式”、`test/index.test.ts`。
3. **超时预算**：出口内部截止 `BPR_BUDGET_MS = 25_000`（omp 的处理器 30 s 超时后会发出原文）；网络层 `NET_BUDGET_MS = 180_000`。两者不得随意加大或去掉。
4. **不记录、不外泄原值。** 通知、`console.error`、`logger.debug`、错误文本只写原因与路径，不写识别到的值或请求内容；不新建全局明文映射文件。**唯一例外**：`/pii list` 与快捷键（`showList`）在本机 omp 界面里显示本会话遮挡的原值——只用 `ctx.ui.custom`（仅本机 TUI，不经 omp 的协作转发、RPC 里不生效），**绝不能用 `ctx.ui.select/confirm/input/editor`**（它们会被转发给协作来宾，RPC 下选项还会进 `extension_ui_request` 帧；`test/list.test.ts` 的源码守卫会拦）；只在 `ctx.mode === "tui"` 且 `ctx.hasUI` 时显示，RPC、print、json、未给出 mode 和子代理一律只提示“需要在 omp 交互界面里查看”，不含原值；只进这个界面，不进通知、日志、对话（`sendMessage`/`sendUserMessage`/`appendEntry`）、状态文件或任何文件，打开列表不新增任何写入（会话文件里本来保存了占位符映射，含原值）；值里的控制字符、零宽字符（U+200B–200F、2060–2064、FEFF 等）和双向控制字符（202A–202E、2066–2069、061C）一律换成可见转义（`visible()`），防止终端转义序列生效或值在屏幕上伪装；列表与 `/pii` 计数同源（`used`），只经网络层遮挡的值（如标题生成）在压缩保存占位符前不计入。占位符映射只在内存里，并经 `pi.appendEntry("pii-guard.map", …)` 写入当前会话（会话文件本身已含原文）。
5. **占位符格式与 HMAC 密钥**：`{{KIND_xxxxxxxx}}`，`xxxxxxxx` = base32 小写 `HMAC-SHA256(key, kind + "\0" + value)` 的前 8 位（碰撞时加长，最长 32），同值同占位符，以保证提示缓存稳定。密钥文件 `<数据目录>/key` 为 32 字节随机数、权限 0600，首次运行时生成，**不进任何请求、不写日志**；长度不对时抛错而不是覆盖；读到时权限不是 0600 一律改回。改占位符外形要同时改 `src/placeholder.ts` 的 `PH_RE` 和 `src/mask.ts` 的 `PROTECTED`，并接受“新旧请求里同一值占位符不同”的缓存代价。
6. **运行时不联网。** 只有 `/pii setup`（`src/setup.ts`）会联网；识别、遮挡、还原全部本地完成。不得在其他路径加遥测、下载、更新检查。
7. **模型固定修订与校验。** 模型文件名、大小、sha256 钉死在 `src/guard.ts` 的 `MODEL_FILES`，`scripts/install.sh` 的 `REV`/`FILES` 保留同值，`test/setup.test.ts` 断言两者一致；加载与 `/pii setup`、`install.sh` 都要校验 sha256，校验失败不替换已有的正确文件。升级模型必须同时改这几处并更新 README 与 `NOTICE` 里的版本说明。模型文件不进仓库。
8. **网络层依赖 omp 内部实现**（`fetch`/`WebSocket`/`http.ClientRequest` 的用法、omp 如何处理 422 与重试）。改 `src/transport.ts`，或放宽 `VERIFIED_VERSION`，必须在 omp 18.18.x 的真实会话里实测，不能只靠假服务器测试；并同步 README 的“已验证环境”“局限”与徽章。包装只装一次，处理函数读全局 `deps`，不要让子代理会话重复包装；`transportProblems()` 自检必须覆盖每一处补丁。
9. **不碰 omp Hide Secrets 的 `$$…$$`。** 受保护的只有：映射表里确实存在的 `{{…}}`，和严格符合 omp 格式（`src/mask.ts` 的 `DOLLAR_SRC`）且**不是本地字面写下的**（`src/local.ts`）的 `$$…$$`。本地扫描不完整（触顶、读不了的内容）时不新增确认。不得因外形像占位符就放行（否则可以夹带真实敏感值）。不得加密钥/令牌正则。
10. **还原策略**（`src/placeholder.ts` 的 `restorePolicy`、`noRestoreTool`）：参数会发往外部服务的工具不还原——`web_search`、`generate_image`、名称以 `web_`/`fetch`/`browser` 开头的工具、全部 `mcp__*` 工具（可用配置 `restoreTools` 放行；`noRestoreTools` 优先于 `restoreTools`）；目标是 `xd://<工具>` 时按该工具套用同一策略，目标是 `ssh://`、`http(s)://`、`mcp://`、`pr://`、`issue://` 等外部 scheme 时整个调用不还原；`LOCAL_SCHEMES` 与无 scheme 的本机路径照常还原。工具参数还原出错时 `tool_call` 返回 `{ block: true }`，不放行。思考块、会话标题、网络层响应不还原。放宽这条会把真值发给第三方。
11. **请求体只改“用户能写进去的文本”**（`src/payload.ts`）：用户/助手文本、工具结果文本、工具调用参数、system/instructions 的字符串叶子。不碰 thinking/signature、`encrypted_content`、compaction 块、工具定义、图片、`id`/`name`/`model`；保留 BigInt、Uint8Array；就地修改，不复制对象。
12. **偏移一律是 JS 字符串下标（UTF-16 码元）。** 从 magpie（Go 字节下标）移植的判断，按字节算长度的地方（如密钥最短 8、`MIN_KNOWN`、数字占比）仍用 `byteLen`（UTF-8 字节数），其余按码元。与 magpie 行为有差别的地方，在代码注释里写明“与 magpie 的差别”和原因（写法参照 `src/known.ts` 文件头）；用例要覆盖 emoji、代理对（`test/offsets.test.ts`）。
13. **子代理与主会话同进程**：模型、缓存、占位符表、网络层包装用 `globalThis` 单例（`Symbol.for("omp-pii-guard.runtime")`、`Symbol.for("omp-pii-guard.transport")`），只装一次；新增全局状态要遵守同一做法，并保证测试里能重置（现有的进程单例由 `testHooks.reset()` 清掉）。

14. **Tern 状态文件是对外契约（版本 1），只含计数与状态。** 文件内容（`TernBody`/`TernFile`，`src/tern.ts`）不得出现任何原值、占位符、会话内容、请求内容；`summary` 来自 `/pii` 的摘要（只有计数、开关和模型加载失败的原因），新增字段前先确认它不会带出这些东西。只有 `TERN_PANE` 是正整数时才写，且只有主会话的交互界面（`ctx.hasUI`、非子代理、`mode` 未给出或为 `tui`）才认领；写入失败一律吞掉（只记 debug），不能影响遮挡、不能让请求失败或放行；写前 lstat 校验状态目录（真实目录、非符号链接、属主是当前用户，权限收紧到 0700，做不到就放弃）；临时文件用随机名 + `wx` 排他创建、0600，再 rename；退出和会话关闭时只删“本实例写过且文件里 pid 是自己”的文件（没认领的进程如 `omp -p` 不得删别人的）。插件把文件当不可信输入，`validate()` 逐项校验后才进缓存，`kill -0` 只对校验过的 pid 调用；新增字段要同步校验（`list` 是可选布尔，缺失当 false，表示列表快捷键已注册且没被别的绑定占用，插件只在它为 true 时发按键）。会话切换（`session_switch`/`branch`/`tree` 不会重跑工厂）时，本会话计数 `used` 由 `loadBranch` 按目标分支里的映射条目重建，`/pii` 与状态文件共用它。改字段含义或格式要提高 `TERN_STATE_VERSION`，同步 `tern-plugin/window.luau`（它只认 `v == 1`）、两份 README 和 `test/tern.test.ts`。插件侧只读这个文件，不得反过来向扩展写东西；唯一的反向动作是点击时向 omp 窗格发送快捷键序列（`window.luau` 的 `LIST_KEY_SEQ` = `ESC[112;7u`，必须与 `src/index.ts` 的 `LIST_KEY` 保持一致，改一处要同步另一处、两份 README 和 `test/list.test.ts`），发之前当场（不用缓存）校验：状态文件有效且 `list == true`、pid 存活、`ps -o stat= -o comm= -p <pid>` 的 stat 含 `+` 且不含 `T`/`Z`（Ctrl+Z 挂起后 pid 仍活着但按键会落进 shell）、可执行文件名为 `omp`（防 pid 被回收复用）、该 pid 环境里的 `TERN_PANE` 等于目标窗格（`ps -Eww` 经 shell 管道的 grep 只取这一个记号；Tern 插件接口不提供窗格的 pid/tty，环境是唯一的关联，读不到按不匹配）、Tern 报告窗格 `kind == "agent"` 或程序名为 `omp`（`fg` 之后 Tern 的程序名会变成 `fg`，所以认 kind）、窗格仍是焦点窗格；任一不满足只 toast 不发送。序列不携带任何数据，插件也不读写任何原值。

15. **持久识别缓存不存原文、原值、占位符，且任何缓存错误都不得导致少遮或原样发出。** `src/cache.ts` 只存 HMAC 键（含 `MODEL_REVISION` 与密钥）、位置/标签/分数与最近使用日；不得新增存文本、值、占位符或可逆推原文的列。读出的行必须逐项校验（整数位置、`0 ≤ start < end ≤ text.length`、标签合法、分数 0–1 有限数），不合法当未命中；打不开、损坏、锁、磁盘满、目录是符号链接一律表现为“未命中 → 照常推理”（`Masker` 里对缓存的每次调用都包在 try/catch 里，且缓存命中只提供 `RawFind[]`，之后仍走同一套阈值、过滤、补遮、替换）；写入失败只记 debug，不抛、不阻塞出口。威胁模型：同一用户能改缓存文件（例如写入空结果让某段文本不被遮挡），与改 `config.json` 的 `allow` 同级，不防，README“局限”写明；缓存是纯派生数据，损坏时删除重建。改键的构成或值格式要同步 `SCHEMA_VERSION`/键前缀版本，旧库自动不命中。
16. **跨进程槽位只是性能措施，不是安全边界。** `src/slots.ts` 任何错误（目录不可用、文件系统出错、被篡改的槽位文件）都退回“立即返回空释放函数”，不得阻塞推理、不得抛、不得让请求失败或少遮；释放只删内容仍是自己 token 的文件；槽位文件内容只有 `pid token 时间`，不含任何文本。已知并接受：回收竞态可能短暂多占一个槽位；旧版本进程不参与限流。`InferenceSession.create` 的 `extra`（关闭自旋）不得去掉，除非实测证明不生效。
17. **预扫描范围只影响“提前扫”，不影响遮挡。** `sentTexts`（`src/index.ts`）只决定后台预扫描扫哪些条目；出口 `maskTexts` 总是遮挡请求里的全部文本，没被预扫的内容在出口照常推理（只是更慢）。`loadBranch`、`/pii` 计数、`session_compact` 里的 `noteUsed` 一律用整条分支，不得改用预扫描范围。

## 6. 改动流程与验证

1. 先读相关模块头部注释和对应测试，再动手。头部注释记录了设计取舍与 magpie 差异，是事实依据；注释与代码不一致时，同一次改动里修正。
2. 行为改动必须配测试：管线/入口/网络层用 `FakeRecognizer`（`test/fake.ts`）与本机 http/WebSocket 服务器验证真实字节；过滤规则的用例沿用 `test/filters.test.ts` 的 `opts()`/`fakeFind()`。不得删改测试、放宽断言、吞异常来让测试通过。
3. 测试隔离：用例用 `PII_GUARD_DIR` 指向临时目录（见 `test/index.test.ts` 的 `beforeEach`），不读写真实的 `~/.omp`；新增用例同样要还原 `process.env` 与全局补丁。
4. 交付前跑全量 `bun test`（或 `BUN_BE_BUN=1 omp test`）并全部通过；只改文档时至少核对文中的命令、路径、配置键与代码一致。
5. 改 `tern-plugin/` 必须在 Tern 里实测（它没有自动化测试，Luau 只在 Tern 窗口里运行）：`tern plugin install tern-plugin --force`，确认 `tern plugin list` 无报错；用临时 HOME、假 key 和 `docs/demo/mock-server.ts` 在一个 Tern 窗格里跑加载本扩展的 omp（不向真实模型服务发请求），确认底栏段出现且计数正确、点击出详情、其他窗格不显示、omp 退出后消失。实测别碰用户正在用的窗口：用 `TERN_CONFIG_DIR` + `TERN_DAEMON_SOCKET` 起独立的 Tern 实例，并用 `tern --control <sock>` 开窗口、`tern ctl --control <sock> shot/tree/click` 观察，用完关闭并清理临时目录。
6. 改动影响识别结果、过滤规则、已知值补遮、线程/窗口、缓存或性能时，重跑 `bun run bench`，并把 README“性能”“找得准不准”里的数字、测试机器与日期一并更新。**README 里的数字必须来自实际运行，不得估算或沿用旧值。**
7. `README.md` 与 `README.zh-CN.md` 同步修改：配置键、环境变量、命令、已验证环境、局限、数字两份必须一致。
8. 配置键（`src/config.ts` 的 `known` 字段集合）、环境变量、`/pii` 子命令有增删时，同步 README“配置”“命令与开关”和 `scripts/install.sh` 的说明；用户可见文案保持中文。
9. 新移植 magpie 代码或数据表：保持 MIT 声明，更新 `NOTICE`（上游提交、范围），文件头注明来源。
10. 依赖升级（`onnxruntime-node`、`@anush008/tokenizers`）要在已验证的 omp 版本上用真模型跑全量测试和基准；锁文件随 `package.json` 一起提交。

## 7. 隐私与公开仓库规则

仓库是公开的，任何提交都会被所有人看到：

- 测试、基准语料、演示、文档、注释里的人名、手机、邮箱、地址、账号、密码**只用虚构数据**，不用真实个人或公司的信息，不粘贴真实会话内容。基准的真实代码语料只允许用 `npm ci` 装出的 `node_modules` 和本仓库 `src/`；`PII_BENCH_DIRS`/`PII_BENCH_SESSIONS` 指向的私有目录只输出计数与形状，不得把真实值写进 README 或提交。
- 虚构邮箱别用 `example.com/.org/.net`、`.test`、`.invalid`、`.example`、`localhost` 等域名来测“会被遮”：`src/email.ts` 的 `realEmail` 把它们当假地址放行，召回率就不是在测真地址（`scripts/bench-corpus.ts` 文件头有同样说明）。测“放行”的用例才故意用它们。
- 虚构的卡号、电话仍可能与真实号码巧合重合；文档不得写成“保证不是真实号码”（见 README“关于合成的值”）。
- 不提交：本机绝对路径、用户名、真实邮箱、令牌与密钥、私有项目或内部服务名、omp 会话日志、模型文件。文档与注释里的路径用 `~`、`<数据目录>`、`<本仓库目录>` 这类占位写法。
- 演示动图和 `.tape` 里出现的数据同样必须是虚构的；重录用临时 HOME 与假 API key，不得带入真实凭据。

## 8. Git 约定

- 主干 `main`，origin 为 GitHub 公开仓库。需要在其他分支上工作时用 `git worktree add`，不在主工作区切换分支。
- 提交信息用中文，一句话说清“做了什么”（沿用仓库历史的写法，无类型前缀）；不写 `update`、`fix` 之类无信息量的内容。
- 本仓库的提交身份必须是 GitHub noreply 邮箱：提交前确认 `git config user.email` 是 noreply 地址，不使用真实邮箱，也不把任何邮箱写进文件。
- 只暂存本次任务涉及的文件，不用 `git add .`；不提交 `node_modules/`、`*.log`、`.DS_Store`（已在 `.gitignore`）和任何模型文件。
- 提交被本地钩子拦下时修好问题再提交，不用 `--no-verify` 绕过。
- 推送、尤其是推送 `main`，是对外且难以撤回的操作：必须先得到用户明确同意，并写明远端与分支（`git push origin main`）；不强制推送，不推送标签，除非用户明确要求。
