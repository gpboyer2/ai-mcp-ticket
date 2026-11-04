// 纯文本视图的统一装配：查工单 → 挂评论 → 渲染。
// REST /api/workspaces/:ws/text、页面 /{ws}/list、MCP ticket_list 三处共用同一份，
// 否则同一份列表在三处会各自漂移（谁挂了评论、谁漏了截断，很快对不上）。
import { renderTicket, renderTicketList, claimLockHint } from './render/text.js';
import { parseStatusFilter } from './repo/workspaces.js';
import { HttpError } from './actor.js';

/**
 * 从请求还原 baseUrl（如 http://192.168.1.10:47321）。
 * 用 Host 头而不是写死 localhost：AI 从局域网访问时该拿到局域网地址，
 * 否则它把 localhost 贴到另一台机器上就访问不到。协议优先信 X-Forwarded-Proto。
 */
export function baseUrlOf(req) {
  const host = req.get?.('host') || req.headers?.host || '';
  if (!host) return '';
  const proto = String(req.get?.('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

/**
 * 查询参数转数字。空值 → undefined（用默认）；非数字 → 400，
 * 不让 NaN 流进 SQL（NaN 会被绑定成 NULL，撞 NOT NULL 约束后变成 500）。
 */
function num(v, name) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, 'NUMBER_INVALID', `${name} 必须是数字，收到 "${v}"`);
  }
  return n;
}

/**
 * 列表纯文本（契约 4.2）
 * @param {{tickets:object, comments:object}} ctx
 * @param {object} ws  工作区行（含 slug/path）
 * @param {object} [query] {status,q,priority,sort,order,limit,offset,maxlen,comments}
 */
export function listTextView(ctx, ws, query = {}, { baseUrl = '' } = {}) {
  const statuses = parseStatusFilter(query.status);
  const rows = ctx.tickets.list(ws, {
    status: statuses ? statuses.join(',') : undefined,
    priority: query.priority,
    q: query.q,
    sort: query.sort,
    order: query.order,
    // 默认给 1000（文本视图要一次看全）；越界由 tickets.list 抛 400，不在这里静默截断
    limit: num(query.limit, 'limit') ?? 1000,
    offset: num(query.offset, 'offset'),
  });
  // 列表默认带评论：AI 靠它一眼看出"有没有新动静"
  const withComments = rows.map((t) => ({ ...t, comments: ctx.comments.list(t.id) }));

  return renderTicketList({
    workspace: ws,
    tickets: withComments,
    statuses,
    maxlen: num(query.maxlen, 'maxlen'),
    comments: num(query.comments, 'comments'),
    baseUrl,
  });
}

/**
 * 单张工单纯文本（契约 4.3），补上 workspace path。
 * @param {object} [opts]
 * @param {{actor?:object}} [opts.writeEvent] 本次是写操作时传入，用于追加锁定提醒（契约 5.5.6）；读操作不要传。
 */
export function ticketTextView(ctx, ws, ticket, { writeEvent, baseUrl = '' } = {}) {
  const full = ctx.tickets.get(ticket.id);
  full.workspace_path = ws ? ws.path : '';
  const hint = writeEvent ? claimLockHint(full, writeEvent.actor) : null;
  return renderTicket(full, { workspace: ws, hint, baseUrl });
}
