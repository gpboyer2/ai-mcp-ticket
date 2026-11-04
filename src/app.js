// Express app 工厂。单独抽出来是为了测试能用 node --test 直接 createApp({dbPath:':memory:'}) 起临时库，
// 不必真的监听端口，也不会污染 data/ticket.db。
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDbPath } from './db.js';
import { HttpError } from './actor.js';
import { createWorkspaceRepo } from './repo/workspaces.js';
import { createTicketRepo } from './repo/tickets.js';
import { createCommentRepo } from './repo/comments.js';
import { createActorRepo } from './repo/actors.js';
import { createApiRouter } from './routes/api.js';
import { createPagesRouter } from './routes/pages.js';
import { createMcpPostHandler } from './mcp.js';
import { createUploadRouter, uploadErrorHandler, resolveUploadDir } from './routes/uploads.js';
import { startWorkspaceSync } from './workspace-sync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const VERSION = '1.0.0';

/**
 * @param {object} [opts]
 * @param {string} [opts.dbPath]    数据库路径，测试传 ':memory:'
 * @param {boolean} [opts.sync]     是否启动 DSH 工作区同步（测试默认关）
 * @param {number} [opts.syncIntervalMs]
 * @param {string} [opts.dshWorkspaceFile] 覆盖 workspace.json 路径（测试用）
 */
export function createApp({
  dbPath,
  sync = true,
  syncIntervalMs = 60_000,
  dshWorkspaceFile,
  uploadDir,
} = {}) {
  const db = openDb(dbPath);
  const workspaceRepo = createWorkspaceRepo(db);
  const ticketRepo = createTicketRepo(db, workspaceRepo);
  const commentRepo = createCommentRepo(db);
  const actorRepo = createActorRepo(db);

  const ctx = {
    db,
    workspaces: workspaceRepo,
    tickets: ticketRepo,
    comments: commentRepo,
    actors: actorRepo,
    syncOpts: dshWorkspaceFile ? { file: dshWorkspaceFile } : {},
  };

  const app = express();
  app.set('x-powered-by', false);

  // 上传路由必须在 express.json() 之前挂：json 中间件会尝试解析二进制 body 并直接 400，
  // 图片根本到不了 handler。本路由自带 express.raw 解析器。
  const uploads = resolveUploadDir(uploadDir);
  app.use('/api', createUploadRouter(uploads), uploadErrorHandler);
  // 图片静态目录：/uploads/:name
  fs.mkdirSync(uploads, { recursive: true });
  app.use('/uploads', express.static(uploads, { index: false, maxAge: '7d' }));

  app.use(express.json({ limit: '2mb' }));

  // 健康检查：放最前面，不依赖任何业务数据
  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      db: resolveDbPath(dbPath),
      uptime: Math.round(process.uptime()),
    });
  });

  // MCP：无状态，每请求一套 server+transport
  const mcpPost = createMcpPostHandler(ctx);
  app.post('/mcp', (req, res, next) => mcpPost(req, res).catch(next));
  const mcpMethodNotAllowed = (req, res) => {
    res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP 端点只支持 POST（无状态模式不支持 SSE / 会话删除）' },
    });
  };
  app.get('/mcp', mcpMethodNotAllowed);
  app.delete('/mcp', mcpMethodNotAllowed);

  app.use('/api', createApiRouter(ctx));
  app.use(createPagesRouter(ctx));

  // 静态前端：web/index.html 还不存在时也不能崩
  if (fs.existsSync(WEB_DIR)) {
    app.use(express.static(WEB_DIR, { index: false, extensions: [] }));
  }

  // 404
  app.use((req, res, next) => {
    next(new HttpError(404, 'NOT_FOUND', `未知路径 ${req.method} ${req.originalUrl}`));
  });

  // 全局错误处理：契约里统一 {error:{code,message}}，绝不把堆栈吐给客户端
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // body-parser 抛的错带 type，归一成稳定的业务错误码（否则客户端拿到的是 "ERROR"）
    const isBodyError = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
    const status = isBodyError ? 400 : Number(err.status || err.statusCode) || 500;
    const code = isBodyError
      ? err.type === 'entity.too.large'
        ? 'PAYLOAD_TOO_LARGE'
        : 'JSON_INVALID'
      : typeof err.code === 'string'
        ? err.code
        : status === 500
          ? 'INTERNAL_ERROR'
          : 'ERROR';
    if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
    if (res.headersSent) return;
    const message = isBodyError
      ? err.type === 'entity.too.large'
        ? '请求体过大（上限 2MB）'
        : 'JSON 解析失败，请检查请求体'
      : status >= 500
        ? '服务器内部错误' // 5xx 只给通用文案，细节留在服务端日志
        : err.message || '请求有误';
    res.status(status).json({ error: { code, message } });
  });

  const syncCtl = sync
    ? startWorkspaceSync(db, workspaceRepo, {
        file: dshWorkspaceFile,
        intervalMs: syncIntervalMs,
      })
    : null;

  return {
    app,
    db,
    ctx,
    close() {
      if (syncCtl) syncCtl.stop();
      try {
        db.close();
      } catch (e) {
        // 重复 close 是幂等的（测试里 close 两次很常见），但真出错要留下痕迹，
        // 否则"关闭失败"会变成难以定位的偶发问题
        console.warn('[app] 关闭数据库时出错（已忽略）:', e.message);
      }
    },
  };
}

export { VERSION };
