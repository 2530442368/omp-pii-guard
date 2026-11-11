--!strict
-- omp-pii-guard 的 Tern 底栏插件：在运行着 omp（已加载 omp-pii-guard 扩展）的窗格的底栏显示一个可点击的 PII 段。
-- 点击底栏段（或命令面板“PII Guard：查看遮挡的值”）：向这个窗格的 omp 发快捷键（只发按键，不发文字），
-- 由 omp 自己在界面里弹出“本会话遮挡的值”列表（完整原值只出现在那个界面里；本插件不读、不写、不经手原值）。
-- 发之前实时确认（任一不满足就只 toast、不发）：状态文件有效且 list == true（扩展的快捷键没被别的绑定占用）、pid 存活、
-- 该 pid 在它终端的前台进程组里且没被挂起（ps stat 含 + 不含 T）、Tern 报告这个窗格正是 omp（kind == "agent"，或程序名是 omp）、窗格仍是焦点窗格。
-- 命令面板“PII Guard：显示遮挡情况”：toast 显示 /pii 的内容（只有计数）。
--
-- 数据来源：扩展写的状态文件 <数据目录>/tern/<TERN_PANE>.json（格式见仓库 README 与 src/tern.ts，只含计数与状态）。
-- <数据目录> 的取值：插件 kv 里的 state_dir（<Tern 数据目录>/plugin-data/pii-guard/kv.json 的 "state_dir"，
-- 必须与扩展的 PII_GUARD_DIR 一致，下面再加 /tern）> Tern 进程环境里的 PII_GUARD_DIR > ~/.omp/agent/pii-guard。
--
-- Tern 的底栏（status line）默认不显示：命令面板里执行“Show status line”（动作 status_bar）打开后才看得到这个段；
-- 没开底栏时仍可从命令面板运行“PII Guard：显示遮挡情况”。
--
-- 约束：底栏 formatter 是纯函数（不能做 IO，4 ms 预算），只读下面的缓存；读文件与判断进程是否存活都在定时器 / 事件 / 命令里做，
-- 结果变了才 tern.chrome.refresh()。轮询只看当前焦点窗格的那一个文件：每 2 秒一次 cx.session:focused() 与 fs.exists，
-- 没有状态文件时不读文件、不起进程；有文件时才解析它，并约每 6 秒起一次 kill -0 确认 omp 进程还在。

type State = {
	v: number,
	pid: number,
	pane: number,
	on: boolean,
	off: string?,
	model: { state: string, reason: string? },
	kinds: { [string]: number },
	requests: number,
	failed: number,
	level: string,
	summary: string,
	list: boolean,
	updatedAt: number,
}

local POLL_MS = 2000
local KINDS = { "PERSON", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT", "SECRET" }
-- 扩展的 LIST_KEY（src/index.ts，ctrl+alt+p）的终端编码：CSI u（kitty 键盘协议），keycode 112 = p，修饰位 7 = 1 + ctrl(4) + alt(2)。
-- cx:run 把它当终端输入写进窗格；omp 把它识别成快捷键并拦下，输入框里的草稿不受影响。两处要一起改。
local LIST_KEY_SEQ = "\27[112;7u"

-- pane -> 最近一次读到、且 pid 存活的状态；没有或已失效的为 nil
local cache: { [number]: State } = {}
local shown = ""
local tick: TimerHandle? = nil

local function stateDir(): string
	local configured = tern.kv.get("state_dir")
	local base = if type(configured) == "string" and configured ~= "" then configured else tern.getenv("PII_GUARD_DIR")
	if base == nil or base == "" then
		base = (tern.getenv("HOME") or "") .. "/.omp/agent/pii-guard"
	end
	return base .. "/tern"
end

local function total(s: State): number
	local n = 0
	for _, k in ipairs(KINDS) do
		local c = s.kinds[k]
		if type(c) == "number" then n += c end
	end
	return n
end

local MAX_PID = 4194304 -- 2^22：Linux pid_max 的上限，macOS 更小
local MAX_COUNT = 1000000000
local MAX_SUMMARY = 500 -- 字符
local MODEL_STATES = { ready = true, loading = true, setup = true, unavailable = true, idle = true }

local function isInt(v: any, lo: number, hi: number): boolean
	return type(v) == "number" and v == v and v >= lo and v <= hi and v == math.floor(v)
end

-- 状态文件是别的进程写的、不可信：逐项校验，只把校验过的字段拷进一张新表；任何一项不符都当作没有状态。
local function validate(data: any, pane: number): State?
	if type(data) ~= "table" then return nil end
	if data.v ~= 1 then return nil end
	if not isInt(data.pid, 1, MAX_PID) or data.pane ~= pane then return nil end
	if type(data.on) ~= "boolean" then return nil end
	local off = data.off
	if off ~= nil and off ~= "env" and off ~= "user" then return nil end
	local model = data.model
	if type(model) ~= "table" or type(model.state) ~= "string" or not MODEL_STATES[model.state] then return nil end
	local reason = model.reason
	if reason ~= nil and reason ~= "files" and reason ~= "other" then return nil end
	if type(data.kinds) ~= "table" then return nil end
	local kinds: { [string]: number } = {}
	for _, k in ipairs(KINDS) do
		local c = data.kinds[k]
		if not isInt(c, 0, MAX_COUNT) then return nil end
		kinds[k] = c
	end
	if not isInt(data.requests, 0, MAX_COUNT) or not isInt(data.failed, 0, MAX_COUNT) then return nil end
	if data.level ~= "info" and data.level ~= "warning" then return nil end
	local summary = data.summary
	if type(summary) ~= "string" then return nil end
	local chars = utf8.len(summary)
	if chars == nil then return nil end
	if chars > MAX_SUMMARY then
		summary = string.sub(summary, 1, utf8.offset(summary, MAX_SUMMARY + 1) - 1) .. "…"
	end
	-- list：扩展的列表快捷键对它可用（已注册且没有别的绑定占着）；可选，缺失当作 false
	local list = data.list
	if list ~= nil and type(list) ~= "boolean" then return nil end
	if type(data.updatedAt) ~= "number" or data.updatedAt ~= data.updatedAt or data.updatedAt < 0 then return nil end
	return {
		v = 1,
		pid = data.pid,
		pane = data.pane,
		on = data.on,
		off = off,
		model = { state = model.state, reason = reason },
		kinds = kinds,
		requests = data.requests,
		failed = data.failed,
		level = data.level,
		summary = summary,
		list = list == true,
		updatedAt = data.updatedAt,
	}
end

-- 读并校验 <pane>.json；读不到、解析不了、校验不过（含不是这个窗格的）都返回 nil。
local function read(pane: number): State?
	if not isInt(pane, 1, 9007199254740991) then return nil end
	local path = string.format("%s/%d.json", stateDir(), pane)
	if not tern.fs.exists(path) then return nil end
	local ok, text = pcall(tern.fs.read, path, 65536)
	if not ok then return nil end
	local okj, data = pcall(tern.json.decode, text)
	if not okj then return nil end
	local okv, state = pcall(validate, data, pane)
	if not okv then return nil end
	return state
end

-- 段的内容（formatter 与变化检测共用；纯函数）。
local function segment(s: State): { text: string, icon: string, tone: string?, command: string }
	local n = total(s)
	local bad = s.model.state == "unavailable" or s.failed > 0 or s.level == "warning"
	if not s.on then
		return { text = "PII 关", icon = "shield", tone = "muted", command = "plugin.pii-guard.list" }
	elseif bad then
		return { text = "PII " .. n, icon = "shield-alert", tone = "error", command = "plugin.pii-guard.list" }
	end
	return { text = "PII " .. n, icon = "shield", tone = if n > 0 then "accent" else nil, command = "plugin.pii-guard.list" }
end

-- 底栏要不要重画的依据：窗格身份 + 有没有状态 + 段的内容。formatter 的结果按输入（窗格）缓存，
-- 切到另一个窗格、或从“没有状态”变成“有”，哪怕段文字一样也必须 refresh，否则缓存里的旧结果（nil）会一直留着。
local function signature(pane: number): string
	local s = cache[pane]
	if not s then return string.format("%d:-", pane) end
	local seg = segment(s)
	return string.format("%d:%s|%s|%s", pane, seg.text, seg.icon, seg.tone or "")
end

-- 进程是否存活：kill -0（退出码 0 = 存在；EPERM 也说明存在）。只在状态文件存在时才起进程，
-- 且同一个 (pane, pid) 的“活着”结论缓存 ALIVE_TTL_MS，所以 omp 运行期间约每 6 秒起一次，没有文件时不起。
local ALIVE_TTL_MS = 6000
local alive: { [number]: { pid: number, at: number } } = {}
local dead: { [number]: string } = {} -- pane -> "pid:updatedAt"：已确认死掉的那份文件，不再重复探测

local function probe(cx: WindowCx, s: State, cb: (boolean, WindowCx?) -> ())
	local known = alive[s.pane]
	if known and known.pid == s.pid and tern.now() - known.at < ALIVE_TTL_MS then
		cb(true, cx)
		return
	end
	local mark = string.format("%d:%d", s.pid, s.updatedAt)
	if dead[s.pane] == mark then
		cb(false, cx)
		return
	end
	tern.process.run({ "/bin/kill", "-0", string.format("%d", s.pid) }, { timeout_ms = 2000 }, function(result, cx2)
		local ok = result.status == 0 or string.find(result.stderr, "not permitted", 1, true) ~= nil
		if ok then
			alive[s.pane] = { pid = s.pid, at = tern.now() }
			dead[s.pane] = nil
		else
			alive[s.pane] = nil
			dead[s.pane] = mark
		end
		cb(ok, cx2)
	end)
end

-- 读 pane 的状态并确认 omp 进程还活着，然后 cb(state 或 nil, 回调时的新 cx)。
-- （进入时的 cx 在处理函数返回后就失效了，异步回调里用第二个参数。）
local function load(cx: WindowCx, pane: number, cb: (State?, WindowCx?) -> ())
	local s = read(pane)
	if not s then
		cb(nil, cx)
		return
	end
	probe(cx, s, function(ok, cx2)
		cb(if ok then s else nil, cx2)
	end)
end

local function poll(cx: WindowCx)
	local pane = cx.session:focused()
	if not pane then
		if shown ~= "" then
			shown = ""
			tern.chrome.refresh()
		end
		return
	end
	load(cx, pane, function(s)
		-- 只保留焦点窗格的缓存，别的窗格的旧状态没人会看
		for k in pairs(cache) do
			if k ~= pane then cache[k] = nil end
		end
		cache[pane] = s
		local sig = signature(pane)
		if sig ~= shown then
			shown = sig
			tern.chrome.refresh()
		end
	end)
end

local function schedule()
	tick = tern.timer(POLL_MS, function(cx)
		tick = nil
		if cx then
			local ok, err = pcall(poll, cx)
			if not ok then tern.log.warn("pii-guard poll failed: " .. tostring(err)) end
		end
		schedule()
	end)
end

-- 底栏：只读缓存。
tern.chrome.status(function(pane)
	local s = cache[pane.pane]
	if not s then return nil end
	return { segment(s) }
end)

-- 焦点换窗格、窗格关闭、窗口启动时立刻看一眼，不等下一次定时器。
tern.on("window_start", function(cx)
	poll(cx)
end)
tern.on("focus", function(_ev, cx)
	if cx then poll(cx) end
end)
tern.on("pane_closed", function(ev, _cx)
	cache[ev.pane] = nil
	shown = ""
end)

local function details(cx: WindowCx)
	local pane = cx.session:focused()
	if not pane then
		cx:toast("info", "没有焦点窗格")
		return
	end
	load(cx, pane, function(s, cx2)
		local c = cx2
		if not c then return end
		if not s then
			c:toast("info", "这个窗格没有运行带 PII 保护的 omp", "需要在窗格里启动加载了 omp-pii-guard 扩展的 omp；只有 Tern 里的 omp 会写状态文件。")
			return
		end
		-- 摘要是 " · " 分隔的一行：开启时前两段是开关与模型状态，其余是计数与请求数；关闭时第一段是开关
		local parts = string.split(s.summary, " · ")
		local head = if s.on then 2 else 1
		local first = table.concat(parts, " · ", 1, math.min(head, #parts))
		local rest = if #parts > head then table.concat(parts, " · ", head + 1) else nil
		local level = if s.level == "warning" then "error" else "info"
		c:toast(level, if rest then first .. "\n" .. rest else first)
	end)
end

tern.command({ id = "details", title = "PII Guard：显示遮挡情况", icon = "shield", run = details })

-- 向焦点窗格的 omp 发快捷键，让它弹出遮挡值列表。发之前（都是此刻现查，不用缓存）要同时满足：
--   1. 状态文件有效（pid 存活、窗格相符）且 list == true（扩展的列表快捷键可用）；
--   2. ps 报告这个 pid 的 stat 含 + 且不含 T/Z：在它终端的前台进程组里、没被 Ctrl+Z 挂起、不是僵尸（挂起后 pid 仍活着，
--      按键却会落到 shell 里）；
--   3. Tern 报告这个窗格正是 omp：kind == "agent"（Tern 的 omp 原生视图），或前台程序名是 omp（普通终端视图；挂起后 Tern 看到的是 zsh）；
--   4. 它仍是焦点窗格。
-- 任一不满足就只提示，不向任何窗格发输入。发出的内容固定为 LIST_KEY_SEQ。
local function programName(info: PaneInfo): string
	local p = info.program
	if type(p) ~= "string" then return "" end
	return string.match(p, "([^/]+)$") or p
end

local function openList(cx: WindowCx)
	local pane = cx.session:focused()
	if not pane then
		cx:toast("info", "没有焦点窗格")
		return
	end
	load(cx, pane, function(s, cx2)
		local c = cx2
		if not c then return end
		if not s then
			c:toast("info", "这个窗格没有运行带 PII 保护的 omp", "需要在窗格里启动加载了 omp-pii-guard 扩展的 omp；只有 Tern 里的 omp 会写状态文件。")
			return
		end
		if not s.list then
			c:toast("info", "在 omp 里输入 /pii list 查看", "列表快捷键没有生效（被别的绑定占用，或 omp 太旧无法确认），所以这里不发按键。")
			return
		end
		tern.process.run({ "/bin/ps", "-o", "stat=", "-p", string.format("%d", s.pid) }, { timeout_ms = 2000 }, function(result, cx3)
			local c3 = cx3
			if not c3 then return end
			local stat = if result.status == 0 then (string.gsub(result.stdout, "%s+", "")) else ""
			local foreground = stat ~= "" and string.find(stat, "+", 1, true) ~= nil and string.find(stat, "T", 1, true) == nil and string.find(stat, "Z", 1, true) == nil
			local info = c3.session:pane(pane)
			local isOmp = info ~= nil and (info.kind == "agent" or programName(info) == "omp")
			if c3.session:focused() ~= pane or info == nil then return end
			if not foreground or not isOmp then
				c3:toast("info", "omp 现在不在这个窗格的前台", "可能被 Ctrl+Z 挂起了，或已退出：用 fg 恢复后再点。没有向窗格发送按键。")
				return
			end
			c3:run(pane, LIST_KEY_SEQ)
		end)
	end)
end

tern.command({ id = "list", title = "PII Guard：查看遮挡的值", icon = "shield", run = openList })

schedule()
