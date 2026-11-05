// stdio MCP：AI 客户端按需拉起的子进程，与操作系统无关（macOS / Windows / Linux 一样）。
// 不依赖 47321 有没有在跑；工具定义与 HTTP 版共用 buildMcpServer（src/mcp.js），只换传输层。
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcp.js';
import { createContext } from './context.js';
import { resolvePort } from './port.js';
import { syncWorkspaces } from './workspace-sync.js';

const ctx = createContext({});
// 工单里的图片要能点开：指回本机看板；看板没起也不影响读写工单本身
const baseUrl = `http://127.0.0.1:${resolvePort(process.env.PORT)}`;

try {
  syncWorkspaces(ctx.db, ctx.workspaces, ctx.syncOpts);
} catch (e) {
  console.error('[workspace-sync] 同步失败，先用库里的旧数据：', e);
}

const server = buildMcpServer(ctx, { baseUrl });
// stdout 是 JSON-RPC 通道，这上面一行多余输出都不能有；诊断信息一律走 stderr
await server.connect(new StdioServerTransport());

function bye() {
  try {
    ctx.db.close();
  } catch (e) {
    console.error('[exit] 关闭数据库出错：', e);
  }
  process.exit(0);
}

process.on('SIGINT', bye);
process.on('SIGTERM', bye);
