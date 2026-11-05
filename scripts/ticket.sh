#!/usr/bin/env bash
# 启停 ai-mcp-ticket 的小脚本，供本机与局域网长期挂着用。
# 为什么不用 pm2：这项目就一个 node 进程，pm2 反而多一层；用 pid 文件最直观。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/data/server.pid"
LOG_FILE="$ROOT/data/server.log"
PORT="${PORT:-47321}"

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

case "${1:-status}" in
  start)
    if is_running; then
      echo "已在运行（pid $(cat "$PID_FILE")）"
      exit 0
    fi
    mkdir -p "$ROOT/data"
    cd "$ROOT"
    nohup node src/server.js >>"$LOG_FILE" 2>&1 &
    sleep 1
    if is_running; then
      echo "已启动（pid $(cat "$PID_FILE")，端口 $PORT）"
      echo "日志：$LOG_FILE"
      for ip in $(node -e "const os=require('os');for(const l of Object.values(os.networkInterfaces()))for(const n of l||[])if(n.family==='IPv4'&&!n.internal)console.log(n.address)"); do
        echo "  局域网：http://$ip:$PORT"
      done
    else
      echo "启动失败，看日志：$LOG_FILE" >&2
      tail -20 "$LOG_FILE" >&2 || true
      exit 1
    fi
    ;;
  stop)
    if ! is_running; then
      echo "没在运行"
      rm -f "$PID_FILE"
      exit 0
    fi
    pid="$(cat "$PID_FILE")"
    kill "$pid"
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "已停止"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if is_running; then
      echo "运行中（pid $(cat "$PID_FILE")，端口 $PORT）"
      curl -s -m 2 "http://127.0.0.1:$PORT/healthz" && echo || echo "（健康检查无响应）"
    else
      echo "未运行"
      exit 1
    fi
    ;;
  *)
    echo "用法：$0 {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
