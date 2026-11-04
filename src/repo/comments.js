// 评论数据访问。关键点：评论的任何写操作都要在同一个事务里刷新所属工单的 updated_at，
// 这样 AI 只靠工单的 updated_at 就能判断"有没有新动静"，不必逐条翻评论。
//
// 状态硬门（契约 5.5.2）：AI 不能在「打开」的工单上写评论。放在这里而不是路由里，是因为
// REST 与 MCP 两条写路径最终都落到 create() —— 一处实现，两边同时生效，不会各自漂移。
import { newId, nowIso } from '../db.js';
import { HttpError } from '../actor.js';

const MAX_BODY = 10000;

function assertBody(body) {
  const b = typeof body === 'string' ? body : '';
  if (!b.trim()) throw new HttpError(400, 'BODY_REQUIRED', 'body 必填');
  if ([...b].length > MAX_BODY) throw new HttpError(400, 'BODY_TOO_LONG', `body 最多 ${MAX_BODY} 字`);
  return b;
}

const toApi = (c) => ({ ...c, model: c.model ?? null });

/**
 * 状态硬门（契约 5.5.2）：AI 不许在「打开」的工单上写评论。
 *
 * 为什么是硬门而不是提醒：提醒放在返回文本末尾，改不改全靠 AI 自己记得，不改没有任何后果，
 * 于是状态永远停在「打开」。这里直接拒绝，AI 必须当场表态——要么先改状态，要么本次一起提交。
 *
 * 只对 role=ai 生效：用户在网页上写评论、拖拽卡片必须照旧，不能被自己的规则挡住。
 * @param {object} ticket     工单（含 status / ref）
 * @param {string|null} nextStatus 本次评论要一起提交的状态（没带就是 null）
 * @param {{role:string}} actor
 * @throws {HttpError} 400 TICKET_NOT_STARTED
 */
function assertStarted(ticket, nextStatus, actor) {
  if (actor.role !== 'ai') return;
  if (ticket.status !== 'open') return;
  // 本次提交把状态推走（in_progress / cancelled 等）就算已经表态，放行；
  // 具体合不合法交给迁移表，这里不重复判规则。
  if (nextStatus && nextStatus !== 'open') return;
  throw new HttpError(
    400,
    'TICKET_NOT_STARTED',
    `工单 ${ticket.ref} 还是「打开」状态，AI 不能在未开始的工单上写评论。两条路选一条：` +
      '① 先把状态改成 in_progress（REST: PATCH /api/tickets/{id} {"status":"in_progress"}；MCP: ticket_update status=in_progress），再写评论；' +
      '② 本次评论直接带 status=in_progress（REST body 的 status 字段；MCP comment_add 的 status 参数），评论与状态一次提交。',
  );
}

/**
 * @param {object} db
 * @param {object} tickets 工单 repo —— 状态迁移与认领释放都走它，不在这里另写一套规则
 */
export function createCommentRepo(db, tickets) {
  const touchTicket = db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?');

  function list(ticketId) {
    return db
      .prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(ticketId)
      .map(toApi);
  }

  /**
   * 批量取多张工单的评论，一次查询搞定（看板 with_comments=1 时用）。
   * 逐张调 list() 会变成 N+1 查询，看板 200 张卡就是 200 次 SQL。
   * @returns {Map<string, Array>} ticketId → 评论数组（升序）
   */
  function listForTickets(ticketIds) {
    const map = new Map(ticketIds.map((id) => [id, []]));
    if (!ticketIds.length) return map;
    const rows = db
      .prepare(
        `SELECT * FROM comments WHERE ticket_id IN (${ticketIds.map(() => '?').join(',')})
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...ticketIds);
    for (const r of rows) map.get(r.ticket_id)?.push(toApi(r));
    return map;
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'COMMENT_NOT_FOUND', `评论不存在: ${id}`);
    return toApi(row);
  }

  /**
   * 写评论，可选同一次提交里改状态（契约 5.5.3）。
   *
   * 为什么状态要跟评论一起提交：这是「已完成」的唯一可靠通道 —— AI 显式写 status=done 才 done，
   * 不做词表猜测。分成两次调用就会出现「评论写成功了、状态没跟上」的半截状态，
   * 所以两者在同一个事务里，状态非法就整条回滚，评论也不落库。
   *
   * @param {string} ticketId
   * @param {{body:string, status?:string}} payload
   * @param {{id:string, role:'user'|'ai', model:string|null}} actor
   * @throws {HttpError} 400 TICKET_NOT_STARTED / STATUS_INVALID / TRANSITION_INVALID、404 TICKET_NOT_FOUND
   */
  function create(ticketId, { body, status }, actor) {
    const text = assertBody(body);
    // 404 与状态都在这一句里拿到，不重复查一次库
    const ticket = tickets.requireTicket(ticketId);
    // 契约 1.6 第 6 条：被他人认领且未过期 → 409（user 例外）。
    // 也放在这里而不是路由里：REST 与 MCP 两条路都要受同一条规则约束。
    tickets.assertWritable(ticketId, actor);
    const nextStatus = status == null || status === '' ? null : String(status);
    // 硬门先判：不合法就别写评论，也别开事务
    assertStarted(ticket, nextStatus, actor);

    const now = nowIso();
    const id = newId();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO comments (id, ticket_id, body, actor_id, actor_role, model, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, ticketId, text, actor.id, actor.role, actor.model ?? null, now, now);
      touchTicket.run(now, ticketId);
      // 状态迁移、落列末尾、done/cancelled 释放认领，全部复用 tickets.update 那一份实现
      if (nextStatus) tickets.update(ticketId, { status: nextStatus }, actor);
    })();
    return get(id);
  }

  function update(id, { body }) {
    const text = assertBody(body);
    const current = get(id);
    const now = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(text, now, id);
      touchTicket.run(now, current.ticket_id);
    })();
    return get(id);
  }

  function remove(id) {
    const current = get(id);
    db.transaction(() => {
      db.prepare('DELETE FROM comments WHERE id = ?').run(id);
      touchTicket.run(nowIso(), current.ticket_id);
    })();
    return { deleted: true, id, ticket_id: current.ticket_id };
  }

  return { list, listForTickets, get, create, update, remove };
}
