#!/usr/bin/env bash
# 重录 README 里的演示动图：docs/demo/demo.zh-CN.gif 与 docs/demo/demo.en.gif。
#
# 前提：vhs、tmux、gifsicle（macOS：brew install vhs tmux gifsicle）、omp 18.18.x、本机已有 AstrLink Guard 模型。
# 用法：docs/demo/record.sh [zh|en|all]（默认 all）
# 环境变量：
#   OMP_BIN             omp 可执行文件（默认 PATH 里的 omp）
#   PII_GUARD_MODEL_DIR 模型目录，含 model_int8.onnx、model_int8.onnx_data、tokenizer.json
#                       （默认 ~/.cache/magpie/astrlink-guard/7216b6a3b897，只读）
#
# 做什么：用临时 HOME（不读写 ~/.omp）、临时数据目录与假 API key 起一个真实的 omp（加载本仓库扩展），
# 让它通过 ANTHROPIC_BASE_URL 指向本机 127.0.0.1 上的模拟服务端（docs/demo/mock-server.ts，不是真实模型）；
# tmux 左栏是 omp，右栏是模拟服务端收到的内容；vhs 回放 .tape 里的输入并录成 GIF，再用 gifsicle 压缩。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LANGS="${1:-all}"
[ "$LANGS" = all ] && LANGS="zh en"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1（brew install vhs tmux gifsicle）" >&2; exit 1; }; }
need vhs; need tmux; need gifsicle

OMP_BIN="${OMP_BIN:-$(command -v omp || true)}"
[ -n "$OMP_BIN" ] && [ -x "$OMP_BIN" ] || { echo "找不到 omp，设置 OMP_BIN" >&2; exit 1; }
REAL_HOME="$HOME"
MODEL_DIR="${PII_GUARD_MODEL_DIR:-$HOME/.cache/magpie/astrlink-guard/7216b6a3b897}"
for f in model_int8.onnx model_int8.onnx_data tokenizer.json; do
  [ -f "$MODEL_DIR/$f" ] || { echo "模型目录 $MODEL_DIR 缺少 $f（设置 PII_GUARD_MODEL_DIR）" >&2; exit 1; }
done
[ -d "$REPO/node_modules/onnxruntime-node" ] || { echo "先在仓库根目录执行 npm ci --ignore-scripts" >&2; exit 1; }

# omp 本身就是 bun 的单文件可执行：没有 bun 时用 BUN_BE_BUN=1 当 bun 跑模拟服务端
if command -v bun >/dev/null 2>&1; then BUN=(bun); else BUN=(env BUN_BE_BUN=1 "$OMP_BIN"); fi

SOCK=pii-demo   # 与 .tape 里的 tmux -L pii-demo attach 一致
SESSION=demo
PORT=18765
COLS=137
ROWS=38

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pii-demo.XXXXXX")"
TMUX=(tmux -L "$SOCK" -f /dev/null)
cleanup() {
  "${TMUX[@]}" kill-server >/dev/null 2>&1 || true
  sleep 1   # omp 退出时还在写 HOME 下的文件
  rm -rf "$TMP" 2>/dev/null || { sleep 2; rm -rf "$TMP"; }
}
trap cleanup EXIT

export HOME="$TMP/home"      # 临时 HOME：omp 的配置、会话、缓存都落在这里，不碰真实的 ~/.omp
mkdir -p "$HOME/shop" "$TMP/data"
export ANTHROPIC_API_KEY=sk-ant-demo-not-a-real-key
export ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
export PII_GUARD_DIR="$TMP/data"
export PII_GUARD_MODEL_DIR="$MODEL_DIR"
unset ANTHROPIC_AUTH_TOKEN OMP_PII_GUARD PII_GUARD_NO_RESTORE OMPCODE
# 从 omp 里运行本脚本时，别把外层 omp 的会话变量（PI_SESSION_FILE 等）带进被录制的 omp
for v in $(compgen -e | grep '^PI_' || true); do unset "$v"; done

# 干净的 omp 配置：跳过首次向导、不查更新、输入时不出联想词、状态栏只留模型与上下文占比（不显示路径、费用）；扩展的流式还原渲染器打开
"$OMP_BIN" config set startup.setupWizard false >/dev/null
"$OMP_BIN" config set startup.checkUpdate false >/dev/null
"$OMP_BIN" config set startup.changelogMode hidden >/dev/null
"$OMP_BIN" config set extensionRenderers.assistantText true >/dev/null
"$OMP_BIN" config set spelling.autocomplete off >/dev/null   # 不要输入时的灰色联想词
"$OMP_BIN" config set spelling.typoDetection false >/dev/null
"$OMP_BIN" config set statusLine.preset custom >/dev/null
"$OMP_BIN" config set statusLine.leftSegments '["model"]' >/dev/null
"$OMP_BIN" config set statusLine.rightSegments '["context_pct"]' >/dev/null

record() {
  local lang="$1" tape out title_l title_r
  if [ "$lang" = zh ]; then
    tape=demo.zh-CN.tape; out=demo.zh-CN.gif
    title_l="omp（pii-guard 已开启）"
    title_r="模拟服务端收到的请求（本地 mock，不是真实模型）"
  else
    tape=demo.en.tape; out=demo.en.gif
    title_l="omp (pii-guard on)"
    title_r="Request the mock server received (local mock, not a real model)"
  fi

  "${TMUX[@]}" kill-server >/dev/null 2>&1 || true
  rm -rf "$HOME/.omp/agent/sessions"
  local omp_cmd
  printf -v omp_cmd 'exec %q -e %q --model anthropic/claude-sonnet-4-5 --no-title' "$OMP_BIN" "$REPO"
  "${TMUX[@]}" new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" -c "$HOME/shop" \
    "$omp_cmd"
  local mock
  printf -v mock 'DEMO_LANG=%s DEMO_PORT=%s exec %q ' "$lang" "$PORT" "${BUN[0]}"
  for a in "${BUN[@]:1}" "$HERE/mock-server.ts"; do printf -v mock '%s%q ' "$mock" "$a"; done
  "${TMUX[@]}" split-window -h -t "$SESSION" -l 58% -c "$HOME/shop" "$mock"
  "${TMUX[@]}" set -t "$SESSION" status off
  "${TMUX[@]}" set -t "$SESSION" pane-border-status top
  "${TMUX[@]}" set -t "$SESSION" pane-border-lines heavy
  "${TMUX[@]}" set -t "$SESSION" pane-border-style "fg=colour240"
  "${TMUX[@]}" set -t "$SESSION" pane-active-border-style "fg=colour75"
  # 栏标题放进 pane 自己的 @title 选项（omp 会不断改写终端标题，pane_title 靠不住）
  "${TMUX[@]}" set -p -t "$SESSION:0.0" @title "$title_l"
  "${TMUX[@]}" set -p -t "$SESSION:0.1" @title "$title_r"
  "${TMUX[@]}" set -t "$SESSION" pane-border-format " #[bold]#{@title}"
  "${TMUX[@]}" select-pane -t "$SESSION:0.0"   # 输入焦点在左栏 omp

  # 等 omp 画出输入框，再等模型预热完成（扩展在会话开始时后台加载）
  for _ in $(seq 1 60); do
    "${TMUX[@]}" capture-pane -p -t "$SESSION:0.0" | grep -q 'π' && break
    sleep 1
  done
  sleep 6

  (cd "$HERE" && HOME="$REAL_HOME" vhs -o "$TMP/raw.gif" "$tape")
  gifsicle -O3 --colors 128 "$TMP/raw.gif" -o "$HERE/$out"
  echo "$HERE/$out: $(du -h "$HERE/$out" | cut -f1)"
}

for l in $LANGS; do record "$l"; done
