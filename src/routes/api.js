// REST API（契约第 3 节）。所有写操作先解析 actor 并登记，再进 repo。
import express from 'express';
import { resolveActor, HttpError } from '../actor.js';
import { syncWorkspaces } from '../workspace-sync.js';
import { listTextView, baseUrlOf } from '../views.js';

export function createApiRouter(ctx) {
  const { db, workspaces, tickets, comments, actors, syncOpts } = ctx;
  const r = express.Router();

  // 写操作统一入口：解析身份 + 登记 actors 表
  const actorOf = (req) => {
    const actor = resolveActor(req, req.body, req.query);
    actors.touch(actor);
    return actor;
  };

  // ---------- 工作区 ----------
  r.get('/workspaces', (req, res) => {
    const includeArchived = String(req.query.include_archived || '') === '1';
    res.json(workspaces.list({ includeArchived }));
  });

  r.post('/workspaces/sync', (req, res) => {
    const result = syncWorkspaces(db, workspaces, syncOpts);
    res.json(result);
  });

  // 契约 4.1：列表的纯文本版本，保证一定返回 text（MCP / 脚本用）
  r.get('/workspaces/:ws/text', (req, res) => {
    const ws = workspaces.find(req.params.ws);
    if (!ws) throw new HttpError(404, 'WORKSPACE_NOT_FOUND', `工作区不存在: ${req.params.ws}`);
    res.type('text/plain; charset=utf-8');
    res.set('Vary', 'Accept');
    res.send(listTextView(ctx, ws, req.query, { baseUrl: baseUrlOf(req) }));
  });

  // ---------- 工单 ----------
  r.get('/workspaces/:ws/tickets', (req, res) => {
    const ws = workspaces.find(req.params.ws);
    if (!ws) throw new HttpError(404, 'WORKSPACE_NOT_FOUND', `工作区不存在: ${req.params.ws}`);
    const { status, priority, q, sort, order, limit, offset } = req.query;
    const list = tickets.list(ws, { status, priority, q, sort, order, limit, offset });

    // 契约 3.2：with_comments=1 才附带评论（看板卡片显示最后一条评论摘要）。
    // 默认不返回是为了省流量；用批量查询而不是逐张查，避免 N+1。
    if (String(req.query.with_comments || '') === '1') {
      const byTicket = comments.listForTickets(list.map((t) => t.id));
      for (const t of list) t.comments = byTicket.get(t.id) || [];
    }

    // counts 是该工作区全量分状态计数（五状态 + total），不受本次筛选影响
    res.json({ workspace: workspaces.toApi(ws), tickets: list, counts: workspaces.countsOf(ws.id) });
  });

  r.post('/workspaces/:ws/tickets', (req, res) => {
    const actor = actorOf(req);
    const ws = workspaces.find(req.params.ws);
    if (!ws) throw new HttpError(404, 'WORKSPACE_NOT_FOUND', `工作区不存在: ${req.params.ws}`);
    const t = tickets.create(ws, req.body || {}, actor);
    res.status(201).json(tickets.get(t.id));
  });

  r.get('/tickets/:id', (req, res) => {
    res.json(tickets.get(req.params.id));
  });

  r.patch('/tickets/:id', (req, res) => {
    const actor = actorOf(req);
    tickets.assertWritable(req.params.id, actor); // 契约 1.6 第 6 条：被他人认领且未过期 → 409（user 例外）
    const t = tickets.update(req.params.id, req.body || {}, actor);
    res.json(tickets.get(t.id));
  });

  r.delete('/tickets/:id', (req, res) => {
    const actor = actorOf(req);
    const { ref } = tickets.remove(req.params.id);
    res.json({ deleted: true, ref });
  });

  // 认领（锁定）：契约 1.6 / 3.2.1
  r.post('/tickets/:id/claim', (req, res) => {
    const actor = actorOf(req);
    const result = tickets.claim(req.params.id, actor);
    res.status(200).json(result.took_over ? { ...result.ticket, took_over: true } : result.ticket);
  });

  // 释放认领：契约 1.6 / 3.2.1
  r.post('/tickets/:id/release', (req, res) => {
    const actor = actorOf(req);
    const ticket = tickets.release(req.params.id, actor);
    res.status(200).json(ticket);
  });

  // ---------- 评论 ----------
  // :id 允许 ref 形式（slug#12），MCP 那边也是同一套解析
  const ticketIdOf = (idOrRef) => tickets.requireTicket(idOrRef).id;

  r.get('/tickets/:id/comments', (req, res) => {
    res.json(comments.list(ticketIdOf(req.params.id)));
  });

  r.post('/tickets/:id/comments', (req, res) => {
    const actor = actorOf(req);
    const ticketId = ticketIdOf(req.params.id);
    // body 里的 status 可选：带上就在同一次事务里改状态（契约 5.5.3）。
    // 认领保护与状态硬门都在 comments.create 里（REST 与 MCP 共用同一处实现）。
    const c = comments.create(ticketId, req.body || {}, actor);
    res.status(201).json(c);
  });

  r.patch('/comments/:id', (req, res) => {
    actorOf(req);
    res.json(comments.update(req.params.id, req.body || {}));
  });

  r.delete('/comments/:id', (req, res) => {
    actorOf(req);
    res.json(comments.remove(req.params.id));
  });

  // ---------- 角色 ----------
  r.get('/actors', (req, res) => {
    res.json(actors.list());
  });

  r.post('/actors', (req, res) => {
    const b = req.body || {};
    // 显式登记必须是 ai（user 无需登记，写操作时自动就有了）
    const actor = resolveActor(
      { headers: {} },
      { actor: { id: b.id, role: b.role || 'ai', model: b.model } },
    );
    res.status(201).json(actors.register(actor));
  });

  // 未知 /api 路径也走统一错误格式
  r.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', `未知接口 ${req.method} ${req.originalUrl}`)));

  return r;
}
