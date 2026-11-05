// 进程入口：装配 app、监听端口、打印可访问 URL、优雅退出。
// 业务代码全在 app.js / routes / repo，这里只负责"起进程"这件事。
import os from 'node:os';
import { createApp, VERSION } from './app.js';
import { resolveDbPath } from './db.js';
import { resolveDshWorkspaceFile } from './workspace-sync.js';
import { resolvePort } from './port.js';
import { pidFilePath, writePidFile, removePidFile } from './pidfile.js';

// 端口解析（工单 ai-剧本#70）：不能写 `Number(env.PORT) || 47321`。
// 因为 Number('0') 是 0，而 0 || 47321 会得到 47321 —— 于是 `PORT=0`（本意是让系统分配随机端口）
// 会静默绑到 47321，正好顶掉用户正在用的真实服务。今天已因此出过两次事故。
// 解析逻辑抽在 src/port.js 里（那边有单测，不用真 bind 端口）。
let PORT;
try {
  PORT = resolvePort(process.env.PORT);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const HOST = '0.0.0.0';

/** 本机局域网 IPv4，方便把地址发给别的机器 / AI */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const dbFile = resolveDbPath();
const pidFile = pidFilePath(dbFile);
const { app, close } = createApp();

const server = app.listen(PORT, HOST, () => {
  // pid 由服务自己写：launchd、scripts/ticket.sh、npm start 起的实例都是同一份，停的时候不用猜。
  try {
    writePidFile(pidFile);
  } catch (e) {
    console.error('[pid] 写 pid 文件失败（服务照常运行）：', e);
  }
  // PORT=0 时由系统分配，真实端口只能从 server.address() 拿；打印 PORT 会显示成 0，误导人。
  const actual = server.address().port;
  console.log(`ai-mcp-ticket v${VERSION} 已启动`);
  console.log(`  数据库: ${dbFile}`);
  console.log(`  工作区源: ${resolveDshWorkspaceFile()}`);
  console.log(`  本机:   http://localhost:${actual}`);
  for (const ip of lanAddresses()) console.log(`  局域网: http://${ip}:${actual}`);
  console.log(`  纯文本: http://localhost:${actual}/?format=text`);
  console.log(`  MCP:    http://localhost:${actual}/mcp`);
});

let closing = false;
function finish() {
  try {
    removePidFile(pidFile);
  } catch (e) {
    console.error('[pid] 删 pid 文件失败（不影响退出）：', e);
  }
  close();
  console.log('已退出');
  process.exit(0);
}

function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在关闭…`);
  // 先停止接收新连接，再关数据库；给在途请求 3 秒收尾
  server.close(finish);
  setTimeout(finish, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
});
