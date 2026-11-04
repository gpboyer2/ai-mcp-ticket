// actors 表：首次出现的身份自动登记，last_seen_at 每次写操作刷新。
// 为什么单独存一张表：AI 换模型后历史评论仍保留旧 model，但"现在有哪些 AI 在干活"要能一眼看到。
import { nowIso } from '../db.js';

export function createActorRepo(db) {
  const upsert = db.prepare(`
    INSERT INTO actors (id, role, model, first_seen_at, last_seen_at)
    VALUES (@id, @role, @model, @now, @now)
    ON CONFLICT(id, role, COALESCE(model, ''))
    DO UPDATE SET last_seen_at = excluded.last_seen_at
  `);

  /** 写操作时调用，登记身份并刷新 last_seen_at */
  function touch(actor) {
    upsert.run({ id: actor.id, role: actor.role, model: actor.model ?? null, now: nowIso() });
  }

  /** 显式登记（POST /api/actors），同样幂等 */
  function register(actor) {
    touch(actor);
    return db
      .prepare(`SELECT * FROM actors WHERE id = ? AND role = ? AND COALESCE(model,'') = COALESCE(?,'')`)
      .get(actor.id, actor.role, actor.model ?? null);
  }

  function list() {
    return db
      .prepare(
        `SELECT a.id, a.role, a.model, a.first_seen_at, a.last_seen_at,
                (SELECT COUNT(*) FROM tickets  t WHERE t.actor_id = a.id AND t.actor_role = a.role
                   AND COALESCE(t.model,'') = COALESCE(a.model,'')) AS ticket_count,
                (SELECT COUNT(*) FROM comments c WHERE c.actor_id = a.id AND c.actor_role = a.role
                   AND COALESCE(c.model,'') = COALESCE(a.model,'')) AS comment_count
           FROM actors a
          ORDER BY a.last_seen_at DESC, a.id ASC`,
      )
      .all();
  }

  function find(id, role) {
    return (
      db
        .prepare('SELECT * FROM actors WHERE id = ? AND role = ? ORDER BY last_seen_at DESC LIMIT 1')
        .get(id, role) || null
    );
  }

  return { touch, register, list, find };
}
