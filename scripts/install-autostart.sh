#!/usr/bin/env bash
# 开机自启（macOS launchd）：登录即起，异常退出自动拉回。
# 直接拿 node 当被启动程序，不经 /bin/sh —— Desktop 有 TCC 保护，shell 写不进项目目录（会报 Operation not permitted）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.$(id -un).ai-mcp-ticket"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-47321}"
LOG="$ROOT/data/launchd.log"

is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

# bootout 是异步的：没等它摘干净就 bootstrap，launchd 会回 37（Operation already in progress）
unload_agent() {
  is_loaded || return 0
  launchctl bootout "$DOMAIN/$LABEL"
  for _ in $(seq 1 50); do
    is_loaded || return 0
    sleep 0.1
  done
  echo "卸载 $LABEL 超时，先手工 launchctl bootout 再试" >&2
  exit 1
}

install_agent() {
  local node_bin
  node_bin="$(command -v node || true)"
  if [[ -z "$node_bin" ]]; then
    echo "找不到 node，先装 Node >= 22" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$PLIST")" "$ROOT/data"

  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$ROOT/src/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>$PORT</string>
    <key>PATH</key>
    <string>$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>

  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF

  unload_agent
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "已登记开机自启：$PLIST"
  echo "  node: $node_bin"
  echo "  端口: $PORT"
  echo "  日志: $LOG"
  echo "  验证: curl -s http://127.0.0.1:$PORT/healthz"
}

remove_agent() {
  unload_agent
  rm -f "$PLIST"
  echo "已取消开机自启（$LABEL）"
}

status_agent() {
  if is_loaded; then
    echo "已登记开机自启，当前状态："
    launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|runs =|last exit code|path ="
  else
    echo "未登记开机自启"
  fi
  if [[ -f "$ROOT/data/server.pid" ]]; then
    echo "pid 文件：$(cat "$ROOT/data/server.pid")"
  else
    echo "pid 文件：无"
  fi
  curl -s -m 2 "http://127.0.0.1:$PORT/healthz" && echo || echo "（健康检查无响应）"
}

case "${1:-install}" in
  install) install_agent ;;
  remove) remove_agent ;;
  status) status_agent ;;
  *)
    echo "用法：$0 {install|remove|status}" >&2
    exit 2
    ;;
esac