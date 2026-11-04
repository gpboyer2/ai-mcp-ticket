#!/usr/bin/env bash
# 截图脱敏核对：对 docs/screenshots/ 下的每张图做 OCR，然后检查有没有泄露本机真实信息。
#
# 为什么要它：README 里的截图是给人看的第一眼印象，但截图很容易带出真实工作区路径、
# 真实工单标题、本机用户名。肉眼看图不可靠也不可复现，所以用 macOS Vision 框架做 OCR，
# 把「图里到底有哪些字」变成可 grep 的文本，再用黑名单逐条查。
#
# 用法：
#   bash scripts/check-screenshots.sh                    # 核对 docs/screenshots/
#   bash scripts/check-screenshots.sh /path/to/dir       # 核对指定目录
#
# 退出码：0 = 全部通过；1 = 发现敏感串（会逐条列出命中位置）

set -uo pipefail

DIR="${1:-docs/screenshots}"
OCR_SWIFT="$(mktemp -t ocr).swift"

if [[ ! -d "$DIR" ]]; then
  echo "目录不存在：$DIR" >&2
  exit 2
fi

shopt -s nullglob
IMAGES=("$DIR"/*.png "$DIR"/*.jpg "$DIR"/*.jpeg)
if [[ ${#IMAGES[@]} -eq 0 ]]; then
  echo "目录里没有图片：$DIR" >&2
  exit 2
fi

# 用 macOS Vision 做 OCR。识别简中/繁中/英文，accurate 级别。
cat > "$OCR_SWIFT" <<'SWIFT'
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("读不到图片: \(path)\n".data(using: .utf8)!)
        continue
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    req.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch {
        FileHandle.standardError.write("识别失败 \(path): \(error)\n".data(using: .utf8)!)
        continue
    }
    let obs = req.results ?? []
    // Vision 的 boundingBox 原点在左下：先按 y 降序（上→下），再按 x 升序（左→右）
    let sorted = obs.sorted { a, b in
        let ay = a.boundingBox.midY, by = b.boundingBox.midY
        if abs(ay - by) > 0.012 { return ay > by }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    print("===== \(path) =====")
    for o in sorted { if let t = o.topCandidates(1).first?.string { print(t) } }
}
SWIFT

echo "OCR 中（Vision 框架，首次编译需几秒）…"
ALL_TEXT="$(swift "$OCR_SWIFT" "${IMAGES[@]}" 2>/dev/null)"
rm -f "$OCR_SWIFT"

if [[ -z "$ALL_TEXT" ]]; then
  echo "OCR 没有输出，可能 Swift/Vision 不可用。改用人工看图核对。" >&2
  exit 2
fi

echo "$ALL_TEXT"

# ---------- 黑名单核对 ----------
# 分三类：本机绝对路径 / 真实工作区名 / 真实工单标题里的特征词。
# 命中任意一条即视为泄露。
PATTERNS=(
  '/Users/[a-zA-Z0-9._-]+'          # 任何本机用户目录
  '/Users/peng'                      # 具体到本机用户名
  'Desktop/Project'                  # 本机项目布局
  'Desktop/AI'                       # 本机项目布局
  'ai-剧本'                          # 真实工作区名
  'ppll-auto-trading'                # 真实工作区名
  'ppll-polymarket'                  # 真实工作区名
  'software-factory'                 # 真实工作区名
  '0-rallies-arena'                  # 真实工作区名
  '0-ppll'                           # 真实目录名
  'cherish-ai'                       # 内部模型路由名（演示数据里若出现需确认是否可公开）
)

FAILED=0
echo "──────────────────────────────────────────────"
echo "敏感串核对："
for p in "${PATTERNS[@]}"; do
  # grep -F 固定串匹配，避免把 . 当正则通配
  HITS="$(echo "$ALL_TEXT" | grep -Fn -- "$p" | head -3)"
  if [[ -n "$HITS" ]]; then
    echo "  ✘ 命中 [$p]"
    echo "$HITS" | sed 's/^/       /'
    FAILED=1
  else
    echo "  ✔ 未出现 [$p]"
  fi
done

echo "──────────────────────────────────────────────"
if [[ $FAILED -eq 1 ]]; then
  echo "结论：✘ 截图里有敏感串，不能进版本库。" >&2
  exit 1
fi

echo "结论：✔ 全部通过 —— 未发现本机路径、真实工作区名、内部模型名。"
echo "（仍建议人工扫一眼 OCR 全文，确认没有黑名单之外的真实内容。）"
exit 0
