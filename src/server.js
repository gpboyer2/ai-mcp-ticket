// 进程入口：装配 app、监听端口、打印可访问 URL、优雅退出。
// 业务代码全在 app.js / routes / repo，这里只负责"起进程"这件事。
import os from 'node:os';
import { createApp, VERSION } from './app.js';
import { resolveDbPath } from './db.js';
import { resolveDshWorkspaceFile } from './workspace-sync.js';

const PORT = Number(process.env.PORT) || 47321;
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

const { app, close } = createApp();

const server = app.listen(PORT, HOST, () => {
  const dbFile = resolveDbPath();
  console.log(`ai-mcp-ticket v${VERSION} 已启动`);
  console.log(`  数据库: ${dbFile}`);
  console.log(`  工作区源: ${resolveDshWorkspaceFile()}`);
  console.log(`  本机:   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  局域网: http://${ip}:${PORT}`);
  console.log(`  纯文本: http://localhost:${PORT}/?format=text`);
  console.log(`  MCP:    http://localhost:${PORT}/mcp`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在关闭…`);
  // 先停止接收新连接，再关数据库；给在途请求 3 秒收尾
  server.close(() => {
    close();
    console.log('已退出');
    process.exit(0);
  });
  setTimeout(() => {
    close();
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
});
