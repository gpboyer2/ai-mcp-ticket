// 页面路由（契约第 4 节）：同一批 URL 双形态 —— 纯文本给 AI，HTML 交给前端。
// 内容协商只在这里判定一次，判定结果决定走 render/text.js 还是交给 web/ 的 SPA 外壳。
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../actor.js';
import { renderWorkspaceIndex, renderNotFound } from '../render/text.js';
import { listTextView, ticketTextView, baseUrlOf } from '../views.js';

const WEB_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web');

/** 契约 4 节：命中即纯文本 */
export function wantsText(req) {
  const urlPath = req.path || '';
  if (/\.txt$/i.test(urlPath)) return true;
  const fmt = String(req.query.format || '').toLowerCase();
  if (fmt === 'text' || fmt === 'txt') return true;
  const accept = String(req.headers.accept || '').toLowerCase();
  if (!accept) return false;
  const plain = accept.indexOf('text/plain');
  if (plain === -1) return false;
  const html = accept.indexOf('text/html');
  // text/plain 排在 text/html 之前 → AI 的 fetch
  return html === -1 || plain < html;
}

/** 去掉 .txt 后缀，拿回干净的 slug / seq */
const stripTxt = (s) => String(s || '').replace(/\.txt$/i, '');

const sendText = (res, body, status = 200) => {
  res.status(status).type('text/plain; charset=utf-8');
  res.set('Vary', 'Accept');
  res.send(body);
};

/** HTML 形态：交给前端 SPA 外壳；web/ 还没写出来时也不能崩 */
function sendHtml(req, res) {
  const indexFile = path.join(WEB_DIR, 'index.html');
  res.set('Vary', 'Accept');
  if (fs.existsSync(indexFile)) {
    res.type('text/html; charset=utf-8');
    res.sendFile(indexFile);
    return;
  }
  res
    .status(200)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta charset="utf-8"><title>ai-mcp-ticket</title>
<body style="font:14px system-ui;padding:2rem;line-height:1.7">
<h1>ai-mcp-ticket</h1>
<p>后端已就绪，前端页面 <code>web/index.html</code> 尚未生成。</p>
<p>现在可以用纯文本视图：<a href="/?format=text">/?format=text</a></p>
</body>`,
    );
}

export function createPagesRouter(ctx) {
  const { workspaces, tickets } = ctx;
  const r = express.Router();

  const requireWs = (wsParam) => {
    const slug = stripTxt(wsParam);
    const ws = workspaces.find(slug);
    if (!ws) throw new HttpError(404, 'WORKSPACE_NOT_FOUND', `工作区不存在: ${slug}`);
    return ws;
  };

  // GET / —— 工作区索引
  r.get('/', (req, res) => {
    if (!wantsText(req)) return sendHtml(req, res);
    sendText(
      res,
      renderWorkspaceIndex({
        workspaces: workspaces.list({ includeArchived: String(req.query.include_archived || '') === '1' }),
        baseUrl: baseUrlOf(req),
      }),
    );
  });

  // GET /{ws}/list —— 看板 / 工单列表纯文本。`.txt` 后缀单独注册一条路由：
  // 契约示例就是 /ppll-auto-trading/list.txt，Express 不会把 list.txt 匹配到 /:ws/list
  const sendListText = (req, res) => {
    const ws = requireWs(req.params.ws);
    if (!wantsText(req)) return sendHtml(req, res);
    sendText(res, listTextView(ctx, ws, req.query, { baseUrl: baseUrlOf(req) }));
  };
  r.get('/:ws/list', sendListText);
  r.get('/:ws/list.txt', sendListText);

  // GET /{ws}/t/{seq}[.txt] —— 单张工单
  r.get('/:ws/t/:seq', (req, res) => {
    const ws = requireWs(req.params.ws);
    const seq = Number(stripTxt(req.params.seq));
    if (!Number.isInteger(seq) || seq <= 0) {
      if (wantsText(req)) return sendText(res, renderNotFound(`工单序号非法: ${req.params.seq}`), 404);
      throw new HttpError(404, 'TICKET_NOT_FOUND', `工单序号非法: ${req.params.seq}`);
    }

    const t = tickets.findByIdOrRef(`${ws.slug}#${seq}`);
    if (!t) {
      if (wantsText(req)) return sendText(res, renderNotFound(`工单不存在: ${ws.slug}#${seq}`), 404);
      throw new HttpError(404, 'TICKET_NOT_FOUND', `工单不存在: ${ws.slug}#${seq}`);
    }
    if (!wantsText(req)) return sendHtml(req, res);
    sendText(res, ticketTextView(ctx, ws, t, { baseUrl: baseUrlOf(req) }));
  });

  // 页面路由自己的错误出口：纯文本请求要拿到 text/plain 的说明（AI 读不了 HTML 错误页）。
  // 非文本请求交回全局错误中间件，保持统一的 JSON 错误体。
  r.use((err, req, res, next) => {
    if (!wantsText(req)) return next(err);
    const status = Number(err.status) || 500;
    if (status >= 500) console.error('[pages]', req.method, req.originalUrl, err);
    sendText(
      res,
      renderNotFound(status >= 500 ? '服务器内部错误' : err.message, {
        status,
        code: err.code || 'ERROR',
      }),
      status,
    );
  });

  return r;
}
