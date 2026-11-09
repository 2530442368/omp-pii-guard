#!/usr/bin/env bash
# 把 pii-guard 装进 omp：
#   1. 校验并复制模型到 <agent>/pii-guard/model/（sha256 与钉死的值比对）。缓存里没有的文件不算错误：照常安装扩展，
#      提示重启 omp 后运行 /pii setup 下载（本脚本不联网）；缓存里有、但大小或 sha256 不符的文件才报错并以非 0 退出。
#   2. 复制扩展（src、package.json、锁文件、NOTICE）到 <agent>/extensions/pii-guard/ 并 `npm ci`。
# 不生成密钥（扩展首次运行时生成 <agent>/pii-guard/key，0600），不改 omp 的任何配置。
#
# 环境变量（都可选）：
#   OMP_AGENT_DIR       omp 的 agent 目录，默认 ~/.omp/agent
#   PII_GUARD_DIR       数据目录（模型、密钥、config.json），默认 <agent>/pii-guard
#   PII_GUARD_MODEL_SRC 模型来源目录，默认 ~/.cache/magpie/astrlink-guard/7216b6a3b897（也认其下的 int8/ 子目录）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
EXT="$AGENT/extensions/pii-guard"
DATA="${PII_GUARD_DIR:-$AGENT/pii-guard}"
MODEL_DST="$DATA/model"
MODEL_SRC="${PII_GUARD_MODEL_SRC:-$HOME/.cache/magpie/astrlink-guard/7216b6a3b897}"

REV="7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4"
HF="https://huggingface.co/QuantumNous/astrlink-guard/resolve/$REV/int8"
# 文件名:大小:sha256
FILES=(
  "model_int8.onnx:330781:0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a"
  "model_int8.onnx_data:37124608:0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067"
  "tokenizer.json:1502881:0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4"
)

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}
size() { wc -c <"$1" | tr -d ' '; }

# 文件是否存在且与钉死的 sha256 一致
verified() { # path size sha
  [ -f "$1" ] && [ "$(size "$1")" = "$2" ] && [ "$(sha256 "$1")" = "$3" ]
}

# ---- 1. 模型 ----
missing=()
corrupt=0
mkdir -p "$MODEL_DST"
for entry in "${FILES[@]}"; do
  IFS=: read -r name sz sum <<<"$entry"
  if verified "$MODEL_DST/$name" "$sz" "$sum"; then
    echo "模型已就绪：$MODEL_DST/$name"
    continue
  fi
  found=""
  bad=0
  for dir in "$MODEL_SRC" "$MODEL_SRC/int8"; do
    if [ -f "$dir/$name" ]; then
      if verified "$dir/$name" "$sz" "$sum"; then
        found="$dir/$name"
        break
      else
        echo "错误：${dir}/${name} 与钉死的大小或 sha256 不符（文件损坏或不是修订 ${REV}）" >&2
        bad=1
      fi
    fi
  done
  if [ -n "$found" ]; then
    # 来源权限可能是 0666：复制后显式设成 0644，不让组/其他用户可写
    cp "$found" "$MODEL_DST/$name.tmp" && chmod 644 "$MODEL_DST/$name.tmp" && mv "$MODEL_DST/$name.tmp" "$MODEL_DST/$name"
    echo "已复制模型：$name"
  else
    [ "$bad" -eq 1 ] && corrupt=1 # 缓存里有、但没有一个校验通过
    missing+=("$name")
  fi
done

if [ "$corrupt" -ne 0 ]; then
  echo >&2
  echo "缓存里的模型文件校验不符，已中止（未安装扩展）。请删除损坏的缓存文件后重新运行，或把 PII_GUARD_MODEL_SRC 指向正确的目录；也可以在装好扩展后用 /pii setup 下载。" >&2
  exit 1
fi

# ---- 2. 扩展 ----
mkdir -p "$EXT"
rm -rf "$EXT/src"
cp -R "$SRC/src" "$EXT/src"
cp "$SRC/package.json" "$SRC/package-lock.json" "$SRC/NOTICE" "$EXT/"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$EXT/"
(cd "$EXT" && npm ci --ignore-scripts --no-audit --no-fund)

echo
echo "已安装：$EXT"
if [ "${#missing[@]}" -gt 0 ]; then
  echo "模型：尚未就位（缺 ${missing[*]}）。本脚本不联网；重启 omp 后运行 /pii setup 下载并校验（约 37 MB），完成前所有发往模型服务的请求都会被阻止。"
  echo "也可以自己从 Hugging Face 固定修订下载到 ${MODEL_SRC} 或 ${MODEL_DST} 后重新运行本脚本："
  for name in "${missing[@]}"; do echo "  ${HF}/${name}"; done
  echo "期望的 sha256："
  for entry in "${FILES[@]}"; do IFS=: read -r name sz sum <<<"$entry"; echo "  $sum  $name"; done
else
  echo "模型：$MODEL_DST"
fi
echo "下一步（本脚本不做，不改 omp 配置）："
echo "  - 重启 omp 会话（新装扩展需重启才生效）"
[ "${#missing[@]}" -gt 0 ] && echo "  - 在 omp 里运行 /pii setup 准备模型"
echo "  - 想让流式回复里也显示原值：omp config set extensionRenderers.assistantText true"
echo "  - 在 omp 里输入 /pii 查看状态"
