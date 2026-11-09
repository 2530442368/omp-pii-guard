# omp-pii-guard

omp 扩展：用本地模型 [AstrLink Guard](https://huggingface.co/QuantumNous/astrlink-guard)（int8，CPU）在请求发往模型服务前，把人名、地址、手机、邮箱、账号、密码换成可还原的占位符 `{{KIND_xxxxxxxx}}`；模型回复里的占位符在本地换回原值。

- 识别：AstrLink Guard 推理（510 token 窗口、重叠 128）→ 移植自 [magpie](https://github.com/yetone/magpie) 的误报过滤（`src/filters.ts` 等：不把代码里的 snake_case 词、import 的模块名、包名当人名/密钥）→ 同一请求内“已遮的值在别处也遮”。
- 占位符 `{{KIND_xxxxxxxx}}` = base32(HMAC-SHA256(key, kind ‖ 0 ‖ value)) 前 8 位。同值同占位符，保证提示缓存稳定。密钥在 `~/.omp/agent/pii-guard/key`（32 字节随机，0600，首次运行时生成，不进任何请求）。
- 不处理密钥正则（那是 omp 自带 Hide Secrets 的事）；两者独立叠加：omp 生成的 `$$…$$` 原样保留，字面写在本地历史里的 `$$…$$` 照常识别（见“工作方式”第 4 点）。
- 失败策略：**fail-closed**。模型不可用、识别出错、格式不支持、超时 → 请求不发出并给出原因与关闭方法（例外见“局限”：未登记的自建网关上认不出格式的体）。

## 工作方式

两层遮挡共用同一个请求体遍历器（只改用户/助手文本、工具结果文本、工具调用参数、system/instructions 的字符串；不碰 thinking/signature、encrypted_content、compaction 块、工具定义、图片、id/name/model、受保护的占位符（第 4 点）；保留 BigInt、Uint8Array）：

1. **`before_provider_request`（主路径）**：按 `ctx.model.api` 选格式——`anthropic-messages`、`openai-responses`、`openai-codex-responses`、`openai-completions`；其他 api（含 `devin-agent`）一律失败。内部截止 25 s（omp 的处理器 30 s 超时后会发出原文）。超时时若网络层在位且请求可识别，放行交给网络层（它没有 30 s 限制，上限 180 s）；否则 `return {}`（请求不发出）。
2. **网络层兜底**（覆盖不经 bpr 的直连：标题直连、本地/远端压缩、judge 等）：包装 `globalThis.fetch`、`globalThis.WebSocket`（按连接排队保序）、`http.ClientRequest.prototype.write/end`。**只处理发往 LLM 推理端点的请求**——路径（不含查询串）以 `/messages`、`/messages/count_tokens`、`/responses`、`/responses/compact`、`/chat/completions`、`/completions` 结尾（含 codex 的 ws `…/responses`），**且**（来源是已知 LLM 服务，或体是 LLM 形状）。已知 LLM 服务按 **origin**（协议 + 主机 + 有效端口；`ws`/`wss` 并入 `http`/`https`；默认端口 80/443）判定，来源 = 内置 `https://api.anthropic.com`、`https://api.openai.com`、`https://chatgpt.com` + omp 模型注册表（`ctx.models.list()`，已认证的可用模型）里各 provider 的 `baseUrl` + bpr 里见到的 `ctx.model.baseUrl` + 环境变量里的提供方基址覆盖（`*_BASE_URL`，如 `ANTHROPIC_BASE_URL`：omp 按它改发请求，`ctx.model.baseUrl` 不反映）。同主机的别的端口、别的协议不是同一个来源（本机网关在 3425，3000 端口上的 MCP 服务不受影响）。
   - **已知服务**的推理端点：体必须能遮挡。`Blob`、`ReadableStream`、`URLSearchParams` 体完整读取后处理，WebSocket 二进制帧按 UTF-8 解码后处理；无法解码、无法解析、认不出格式的体一律不发出。WebSocket JSON 帧：`type` 为 `response.create` 的走遮挡；其他帧必须有字符串 `type`，且所有字符串值都在 `type`、`id`、`event_id`、`response_id`、`item_id`、`previous_response_id` 键下才放行，否则不发出（包括 bpr 失败后 omp 发出的空壳 `{}`）。
   - **未知来源**的推理路径：认不出、解析不了、不支持编码的体原样放行（未知来源上的 MCP SSE `/messages`、聊天软件 `/channels/1/messages` 等普通 JSON 不受影响）；LLM 形状的体照常遮挡，遮挡失败仍不发出。
   - 其他请求（同主机的 oauth、models 列表，路径不符的 JSON）字节不变。fetch 先合成实际生效的 `Request`（`new Request(input, init)` 语义）再取头、解码、改写。支持 `content-encoding` identity/gzip/deflate/br，改写后重新压缩并更新 `Content-Length`；已知服务上 zstd 等不支持的编码 → 不发出。
   - **不发出时 omp 不会重试**（omp 18.18.1 把连接类错误——fetch 拒绝被 SDK 包成 `Connection error.`、WebSocket 关闭——当成可重试，会重试约 10 次，`-p` 150 s 以上不退出）：fetch 不拒绝，返回合成的 **HTTP 422**（头 `x-should-retry: false`，JSON 错误体 `code: pii_guard_blocked`；422 不在 omp/SDK 的重试集合里，也不触发 400/413 才有的 `~/.omp/logs/http-400-requests/` 请求转储）；WebSocket 先向连接投递一帧服务端 `error` 事件（`code: pii_guard_blocked`，codex 提供方转成不可重试的错误），再以 1000 正常关闭；ClientRequest 同样不 `destroy` 成连接错误（Anthropic SDK 会把它包成连接错误重试），而是向调用方产出合成的 422 `IncomingMessage` 响应（`'response'` 事件；头 `x-should-retry: false`、与 fetch 相同的 JSON 错误体；响应读完后销毁请求，没人监听 `response` 时丢弃），原请求从未发出。omp 18.18.1 的 Anthropic 直连实测走的就是这条路径（omp 自己的日志记为 `cowork transport rejected … status 422 … x-should-retry false`）。错误文本是固定的英文句子，具体原因（模型缺失等）在界面提示里。`-p` 在几秒内以非 0 退出，请求不发出。
3. 识别结果按文本 sha256 缓存（LRU，键含 args 语境与配置指纹，同一文本只推理一次）；有改动的遮挡产出按同样的键记入缓存，第二层遇到时不重复推理，换语境则不命中。后台预扫描用 `ctx.setTimeout`：`session_start` 扫整条分支，`input`/`tool_result`/`assistant_message`/`tool_call` 到达时扫新内容，出口大多命中缓存。
4. 已遮挡的值记住模型识别分数（持久化时随映射写入，分数提高时追加更新，重建时同一占位符取最高分）；调高 `threshold` 后，分数不够的旧值不再补遮（占位符映射仍在，还原照常）。受保护的占位符只有两种：映射表里确实存在的 `{{…}}`，和 omp 刚生成的 `$$…$$`。后者要同时满足：严格符合 omp 格式（`$$` + 可选 `大写字母数字{1,32}_` + 12 位 `[0-9A-Z]` + 可选 `:大写字母` + `$$`），**且不是本地字面写下的**——omp 在本地存原值，只在发往模型时才混淆，所以一个严格格式的 `$$…$$` 只要在本地会话分支的任何条目（消息、工具结果、自定义消息、压缩/分支摘要、文件提及……的任意字符串）或本地系统提示（`ctx.getSystemPrompt()`）里字面出现过，就是用户/工具/文件写下的文本（可能正是一个真实密码），照常识别，识别区间若是整个 `$$<值>$$` 则去掉两侧的 `$$` 后过滤。本地没有的才保护，并记入进程内“已确认”集合（上限 2 万）；网络层只保护这个集合里的。读不到本地会话时一个都不保护（宁可多遮）。本地扫描要完整才算数：遍历触顶（深度 12、节点 20 万）、遇到读不了的内容（`Map`、类实例等）、系统提示读取失败时，没扫到不等于本地没有——这次请求不新增确认，不在已确认集合里的严格格式 `$…$` 一律照常识别，已确认的照旧保护；不完整的标记随条目缓存，不会被当成完整。模型识别的区间与占位符相交时只剪掉占位符部分，其余照遮；已知值补遮不受占位符保护影响（`$$<已知值>$$` 里的已知值照遮）。
5. PERSON 类、由 2–4 个汉字组成且已过阈值的已知值（张伟）参与已知值补遮：不受 8 字节最短长度限制（与 magpie 的差别，隐私优先），模型在别处只给低分时也遮。不足 8 字节（两字）的名字与普通词同形（方圆、江山）时，没有角色词/称谓的语境不补遮；3–4 字名字保持 magpie 原样。

还原：

- `tool_call`：深度还原参数（写文件、执行命令拿到真值）。**默认不还原**（参数会发往外部服务）：`web_search`、`generate_image`、名称以 `web_`/`fetch`/`browser` 开头的工具、全部 `mcp__*` 工具；调用目标（`path`/`file_path`/`uri`/`url`）是 `xd://<工具>` 时按该工具套用同一策略（`write xd://mcp__…` 就是调用 MCP），是 `ssh://`、`http(s)://`、`mcp://`、`pr://`、`issue://` 等外部 scheme 时整个调用不还原；`local://`、`agent://`、`out://`、`artifact://`（及 `file`、`skill`、`history`、`proc`、`omp`）和无 scheme 的本机路径照常还原。`read` 的其他 URL 形态叶子也不还原。想让本地 MCP（如 dbhub、git）还原，在 `restoreTools` 里放行（如 `["mcp__dbhub*"]`）；`noRestoreTools` 追加不还原的工具，且优先于 `restoreTools`。
- `assistant_message`：文本块换回原值写入历史/持久化（`omp -p` 输出、`/copy`、子代理交回内容为真值；下次请求时在出口重新遮挡）。
- 助手文本渲染器：流式显示时换回原值，行尾未闭合的 `{{…` 先隐藏。需要 `omp config set extensionRenderers.assistantText true`。
- 思考块、会话标题不还原（接口不支持）。

映射持久化：请求里出现的占位符（连同识别分数）经 `pi.appendEntry("pii-guard.map", …)` 写入当前会话（会话文件本身已含原文，不新增暴露面），`session_start`/`switch`/`branch`/`tree` 时从分支重建。网络层遮挡的请求（本地/远端压缩等）不经 bpr，所以 `session_compact` 时把压缩结果与分支里出现的已知占位符补写进事件所属的会话，`--resume` 后摘要里的占位符才能还原。不建全局明文映射文件。子代理与主会话同进程，模型、缓存、占位符表和包装用 `globalThis` 单例，只装一次。

## 安装

已验证环境：omp 18.18.x、macOS arm64（其他环境未验证；网络层依赖 omp 内部实现，版本不是 18.18.x 时会提示）。需要约 40 MB 磁盘存放模型、运行时常驻内存约 +100 MB。

### 方式一：omp plugin（推荐）

```sh
omp plugin install github:2530442368/omp-pii-guard
```

1. 重启 omp。此时还没有模型，**所有发往模型服务的请求都会被阻止**（fail-closed），提示里会指向 `/pii setup`。
2. 在 omp 里运行 `/pii setup`：只有这个命令会联网（扩展从不自动下载）。顺序：目标目录里已有且校验通过的文件跳过 → 本机 magpie 缓存里有且校验通过的复制 → 否则从 Hugging Face 固定修订下载三个文件（约 37 MB）。每个文件先写同目录的临时文件，校验大小与 sha256 通过后才原子替换；校验失败、HTTP 错误、超时、重定向降级到 http 都不留下目标文件、不替换已有的正确文件，并给出原因。完成后无需重启即可遮挡。
3. （可选）想让流式回复里也显示原值：`omp config set extensionRenderers.assistantText true`。
4. `/pii` 查看状态。

模型来源：[QuantumNous/astrlink-guard](https://huggingface.co/QuantumNous/astrlink-guard) 修订 `7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4` 的 `int8/` 目录：
`https://huggingface.co/QuantumNous/astrlink-guard/resolve/7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4/int8/{model_int8.onnx,model_int8.onnx_data,tokenizer.json}`（Hugging Face 会重定向到 CDN）。期望的大小与 sha256 钉死在 `src/guard.ts` 的 `MODEL_FILES`（`scripts/install.sh` 保留同值，测试断言二者一致）。模型 Apache-2.0，不进本仓库。

模型默认存到 `~/.omp/agent/pii-guard/model/`（`PII_GUARD_DIR` / `PII_GUARD_MODEL_DIR` 可改）。`PII_GUARD_MODEL_SRC` 指定本机缓存目录（默认 `~/.cache/magpie/astrlink-guard/7216b6a3b897`，也认其下的 `int8/`）。

### 方式二：克隆后用脚本安装

```sh
git clone https://github.com/2530442368/omp-pii-guard && cd omp-pii-guard
scripts/install.sh
```

- 模型：先尝试从 magpie 缓存复制到 `~/.omp/agent/pii-guard/model/` 并校验 sha256（结果文件权限 0644）。缓存里没有的文件**不算错误**：脚本照常安装扩展（退出码 0），打印固定修订的下载地址，并提示重启 omp 后运行 `/pii setup` 下载（脚本本身不联网，模型就绪前所有请求都会被阻止）。缓存里有、但大小或 sha256 不符的文件才报错并以非 0 退出（不安装扩展）。
- 扩展：复制 `src/`、`package.json`、锁文件到 `~/.omp/agent/extensions/pii-guard/` 并 `npm ci --ignore-scripts`（依赖钉死 `onnxruntime-node@1.31.1`、`@anush008/tokenizers@0.6.0`）。
- 不生成密钥，不改 omp 配置。装完重启 omp 会话。

开发时不要把代码直接放进 `~/.omp/agent/extensions`（会被所有新会话加载）；用 `omp -e <本仓库目录>` 显式加载。

## 开关

| 方式 | 作用 |
| --- | --- |
| `/pii` | 单行状态摘要（以 ` · ` 分隔，通知气泡不保留换行时也可读）：开关、模型是否就绪、本会话已遮挡的类别（人名、地址、手机、邮箱、账号、密码）及不同值的个数、已检查的请求数（出口与网络层不重复计数）；有失败、模型不可用、网络层未就位、非默认阈值/类别、还原关闭时追加对应项（有 ⚠ 或失败时通知级别为 warning） |
| `/pii setup` | 准备模型：已有且校验通过的跳过，其次复制本机缓存，否则从 Hugging Face 固定修订下载并校验（约 37 MB，后台进行，完成后有通知；进行中再次执行不会并发下载）。只有这个命令会联网 |
| `/pii off` / `/pii on` | 关闭/开启遮挡（作用于本进程所有会话，含子代理；关闭后请求原样发出，还原仍然有效） |
| `OMP_PII_GUARD=off` | 全局关闭（无界面时用）：不装网络层、不注册钩子，只留 `/pii` |
| `PII_GUARD_NO_RESTORE=1` | **仅测试用**：关闭所有还原，让模型原样复述，证明服务端收到的是占位符 |

模型文件缺失/损坏时，请求被阻止，提示里写明缺哪个文件、指向 `/pii setup`、如何关闭（`OMP_PII_GUARD=off`）。

## 配置

可选文件 `~/.omp/agent/pii-guard/config.json`（`session_start` 时读取；字段非法时回落默认并提示）：

```json
{
  "threshold": 0.8,
  "threads": 4,
  "kinds": ["PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT", "SECRET"],
  "allow": ["某个误报词"],
  "noRestoreTools": ["my_http_tool", "mcp_search*"],
  "restoreTools": ["mcp__dbhub*"]
}
```

- `threshold`：模型分数阈值，0.5–1，默认 0.8。
- `threads`：ONNX Runtime 线程数，默认 `min(4, 核数/2)`。全局并发窗口数 = `核数 / threads`。更改需重启 omp。
- `kinds`：启用的类别，默认全部。
- `allow`：永不遮挡的整值（不分大小写），修误报用。
- `noRestoreTools`：追加的不还原工具名（通配，`*` 匹配任意串；不分大小写）。
- `restoreTools`：放行还原的工具名（通配）。`mcp__*` 工具默认不还原，本地 MCP 在这里放行。

环境变量：`PII_GUARD_DIR`（数据目录）、`PII_GUARD_MODEL_DIR`（模型目录）。

## 启动自检

`session_start` 检查网络层包装仍在位；omp 版本不是已验证的 18.18.x 时提示“网络层遮挡未在此版本验证”（不阻断）；后台预热模型，加载失败立刻提示。

## 局限

- 网络层依赖 omp 内部实现（fetch/WebSocket/`https.request` 的用法）。omp 升级换了发请求方式会让直连路径悄悄漏遮（bpr 路径仍有遮挡），所以有版本提示。
- 不支持的请求格式（`devin-agent`、Google、Bedrock 等）：bpr 层失败（请求被阻止）；网络层对已知主机上匹配推理路径的认不出的体同样不发出，路径不匹配的原样放行。四种受支持格式的 SDK 请求路径固定以 `/messages`、`/responses`、`/chat/completions` 结尾（网关前缀不影响），bpr 超时交给网络层依赖这一点。
- 不在已知 origin 里的自建网关（没进模型注册表、没设 `*_BASE_URL`、bpr 里也没出现过），其推理路径上认不出格式的体（如 zstd 压缩体）会原样放行；LLM 形状的 JSON 仍会遮挡。
- `$$…$$` 来源判断的剩余边界：不在会话分支里、也不在系统提示里的请求内容（`/btw` 未落盘的文本、请求时才拼进去的提醒或文件内容）里字面写出的严格格式 `$$…$$`，会被当成 omp 的占位符保护（不遮）。
- 网络层不读取非推理端点的 `FormData` / 流体（原样放行）。
- 密钥文件读到时权限不是 0600 一律改回 0600。
- 思考块里带有的原文不可改；会话标题由模型对已遮挡的首条消息生成，可能带占位符；两者显示占位符。
- 不在网络层还原响应；模型改写占位符（大小写、截断）时无法还原。
- codex 后续轮次的 `input` 只含增量（历史在服务端）；回溯补遮只影响之后的请求。
- 首次打开很长的旧会话要等后台预扫描（约 50 ms/KB，4 线程）；扫描超预算时按 fail-closed 处理，而不是发出原文。
- 常驻内存约 +100 MB（Bun 下，含模型）。
- `omp commit` 等不加载扩展的 CLI 子命令不覆盖。
- 不遮 url/ip/日期；不处理图片/PDF；不做 magpie 的自定义遮挡词。
- 大段无空白的 base64/哈希样长串（≥1 KB，仅含 `A-Za-z0-9+/_=-`）视为二进制载荷，不送模型识别（已知值补遮照做）。

## 测试

```sh
bun test        # 有 Bun 时
BUN_BE_BUN=1 omp test   # 没有 Bun 时：omp 二进制自带 Bun（路径按你的安装位置，如 Tern 的 omp/versions/18.18.1）
```

含 T2 移植的 magpie 用例、假识别器驱动的管线/入口/网络层测试（本机 http 与 WebSocket 服务器验证真实字节）、真模型测试（模型目录默认 magpie 缓存，不存在则跳过）。`scripts/bench.ts` 在你自己的语料上输出各类别遮挡数与耗时（只输出形状与计数）；语料目录用 `PII_BENCH_DIRS`（代码）、`PII_BENCH_SESSIONS`（omp 会话目录）指定，脚本里没有默认语料。

## 署名

- 误报过滤移植或派生自 [magpie](https://github.com/yetone/magpie)（MIT），声明见 `NOTICE`。
- 模型 [QuantumNous/astrlink-guard](https://huggingface.co/QuantumNous/astrlink-guard) v0.1.3（Apache-2.0），本仓库不分发模型文件。
