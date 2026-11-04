// 评论数据访问。关键点：评论的任何写操作都要在同一个事务里刷新所属工单的 updated_at，
// 这样 AI 只靠工单的 updated_at 就能判断"有没有新动静"，不必逐条翻评论。
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

export function createCommentRepo(db) {
  const touchTicket = db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?');

  function requireTicketId(ticketId) {
    const row = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId);
    if (!row) throw new HttpError(404, 'TICKET_NOT_FOUND', `工单不存在: ${ticketId}`);
    return row.id;
  }

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

  function create(ticketId, { body }, actor) {
    const text = assertBody(body);
    requireTicketId(ticketId);
    const now = nowIso();
    const id = newId();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO comments (id, ticket_id, body, actor_id, actor_role, model, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, ticketId, text, actor.id, actor.role, actor.model ?? null, now, now);
      touchTicket.run(now, ticketId);
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
