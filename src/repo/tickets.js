// 工单数据访问。所有写操作走事务，统一维护 updated_at；
// position 的"落到列末尾"逻辑集中在这里，REST / MCP 都调它，避免两套排序规则。
import { newId, nowIso } from '../db.js';
import { HttpError } from '../actor.js';
import { STATUSES, parseStatusFilter } from './workspaces.js';

export const POSITION_STEP = 1024;

function rowToTicket(r, slug) {
  return {
    id: r.id,
    ref: `${slug}#${r.seq}`,
    workspace_id: r.workspace_id,
    workspace_slug: slug,
    seq: r.seq,
    title: r.title,
    body: r.body ?? '',
    status: r.status,
    priority: r.priority,
    position: r.position,
    blocked_by: r.blocked_by ?? '',
    actor_id: r.actor_id,
    actor_role: r.actor_role,
    model: r.model ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const SORTS = {
  position: 't.position',
  created_at: 't.created_at',
  updated_at: 't.updated_at',
  priority: 't.priority',
};

function assertTitle(title) {
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) throw new HttpError(400, 'TITLE_REQUIRED', 'title 必填');
  if ([...t].length > 200) throw new HttpError(400, 'TITLE_TOO_LONG', 'title 最多 200 字');
  return t;
}

function assertPriority(p) {
  if (p == null || p === '') return undefined;
  const n = Number(p);
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    throw new HttpError(400, 'PRIORITY_INVALID', 'priority 只能是 0/1/2/3');
  }
  return n;
}

function assertStatus(s) {
  if (s == null || s === '') return undefined;
  if (!STATUSES.includes(s)) {
    throw new HttpError(400, 'STATUS_INVALID', `未知状态 "${s}"，合法值: ${STATUSES.join(',')}`);
  }
  return s;
}

/**
 * position 校验：必须是有穷数字。不校验就会把 NaN 直接塞进 SQL，
 * NOT NULL 约束在 SQLite 里会以 500 的形式炸出来（NaN 绑定为 NULL）。
 * 空值（null / undefined / ''）表示"不指定"，返回 null 由调用方决定落列末尾。
 */
function assertPosition(p) {
  if (p == null || p === '') return null;
  const n = Number(p);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, 'POSITION_INVALID', `position 必须是数字，收到 "${p}"`);
  }
  return n;
}

// 契约 1.3：正文上限 100000 字。存在意义是防止 AI 或误操作把整份文件贴进来把库撑爆。
// 按字符数（不是 UTF-16 码元）算，中文不会被当成 2 个。
export const BODY_MAX = 100000;

function assertBody(body) {
  const b = typeof body === 'string' ? body : String(body ?? '');
  const n = [...b].length;
  if (n > BODY_MAX) {
    throw new HttpError(400, 'BODY_TOO_LONG', `body 最多 ${BODY_MAX} 字，收到 ${n} 字`);
  }
  return b;
}

// 契约 5.5.1：合法状态迁移表。reopened 的存在就是为了把 done/cancelled 救回来，
// 所以不开放 done→open 这种跳步；同状态迁移（幂等）必须允许，否则前端拖回原位会报错。
const TRANSITIONS = {
  open: ['open', 'in_progress', 'cancelled'],
  in_progress: ['in_progress', 'done', 'reopened', 'cancelled', 'open'],
  reopened: ['reopened', 'in_progress', 'cancelled'],
  done: ['done', 'reopened'],
  cancelled: ['cancelled', 'reopened'],
};

export function allowedTransitions(from) {
  return TRANSITIONS[from] || [];
}

function assertTransition(from, to) {
  if (from === to) return; // 幂等：前端拖回原位不该报错
  const allowed = TRANSITIONS[from];
  if (!allowed) {
    throw new HttpError(400, 'TRANSITION_INVALID', `未知的当前状态 "${from}"`);
  }
  if (!allowed.includes(to)) {
    throw new HttpError(
      400,
      'TRANSITION_INVALID',
      `不能从「${from}」直接改成「${to}」。从 ${from} 只能去 ${allowed.join('/')}` +
        '（要重开已完成的工单请先改成 reopened）',
    );
  }
}

export function createTicketRepo(db, workspaceRepo) {
  // 同一事务里复用 prepared statement，避免每次 prepare 的开销
  const tailStmt = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM tickets WHERE workspace_id = ? AND status = ?');

  /** 目标状态列的末尾位置。空列给 1024，避免 position 从 0 开始时负数/0 的边界 */
  function tailPosition(workspaceId, status) {
    const { m } = tailStmt.get(workspaceId, status);
    return (m || 0) + POSITION_STEP;
  }

  function nextSeq(workspaceId) {
    // 计数器独立于 tickets，删除工单后序号不回收
    db.prepare('INSERT OR IGNORE INTO ticket_seq (workspace_id, next_seq) VALUES (?, 1)').run(workspaceId);
    const { next_seq: seq } = db.prepare('SELECT next_seq FROM ticket_seq WHERE workspace_id = ?').get(workspaceId);
    db.prepare('UPDATE ticket_seq SET next_seq = ? WHERE workspace_id = ?').run(seq + 1, workspaceId);
    return seq;
  }

  function requireWorkspace(ws) {
    const row = workspaceRepo.find(ws);
    if (!row) throw new HttpError(404, 'WORKSPACE_NOT_FOUND', `工作区不存在: ${ws}`);
    return row;
  }

  function requireTicket(idOrRef) {
    const row = findByIdOrRef(idOrRef);
    if (!row) throw new HttpError(404, 'TICKET_NOT_FOUND', `工单不存在: ${idOrRef}`);
    return row;
  }

  /** ref 形如 slug#12；也接受 uuid */
  function findByIdOrRef(idOrRef) {
    if (!idOrRef) return null;
    const raw = String(idOrRef).trim();
    const m = raw.match(/^(.+)#(\d+)$/);
    if (m) {
      const [, slug, seq] = m;
      const ws = workspaceRepo.find(slug);
      if (!ws) return null;
      const r = db.prepare('SELECT * FROM tickets WHERE workspace_id = ? AND seq = ?').get(ws.id, Number(seq));
      return r ? rowToTicket(r, ws.slug) : null;
    }
    const r = db.prepare('SELECT * FROM tickets WHERE id = ?').get(raw);
    if (!r) return null;
    const ws = workspaceRepo.find(r.workspace_id);
    return rowToTicket(r, ws ? ws.slug : '');
  }

  function list(workspaceRow, { status, priority, q, sort = 'position', order, limit = 200, offset = 0 } = {}) {
    const statuses = parseStatusFilter(status);
    const where = ['t.workspace_id = ?'];
    const params = [workspaceRow.id];
    if (statuses) {
      where.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const pr = assertPriority(priority);
    if (pr !== undefined) {
      where.push('t.priority = ?');
      params.push(pr);
    }
    const keyword = typeof q === 'string' ? q.trim() : '';
    if (keyword) {
      where.push('(t.title LIKE ? ESCAPE \'\\\' OR t.body LIKE ? ESCAPE \'\\\')');
      const like = `%${keyword.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      params.push(like, like);
    }

    const col = SORTS[sort];
    if (!col) throw new HttpError(400, 'SORT_INVALID', `sort 只能是 ${Object.keys(SORTS).join('/')}`);
    const dir = String(order || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    // position 默认升序（越小越靠前），时间/优先级默认降序更符合直觉
    const finalDir = order ? dir : sort === 'position' ? 'ASC' : 'DESC';

    // limit / offset：非法值给明确 400，别静默吞掉（前端传错了要能立刻看出来）。
    // 契约规定上限 1000，超过也报 400 而不是偷偷截断。
    const rawLimit = Number(limit);
    const lim = limit === undefined || limit === '' ? 200 : rawLimit;
    if (!Number.isInteger(lim) || lim < 1) {
      throw new HttpError(400, 'LIMIT_INVALID', 'limit 必须是 1..1000 的整数');
    }
    if (lim > 1000) throw new HttpError(400, 'LIMIT_TOO_LARGE', 'limit 上限 1000');

    const rawOffset = Number(offset);
    const off = offset === undefined || offset === '' ? 0 : rawOffset;
    if (!Number.isInteger(off) || off < 0) {
      throw new HttpError(400, 'OFFSET_INVALID', 'offset 必须是 >= 0 的整数');
    }

    const rows = db
      .prepare(
        `SELECT t.* FROM tickets t WHERE ${where.join(' AND ')}
          ORDER BY ${col} ${finalDir}, t.created_at ${finalDir}, t.rowid ${finalDir}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, lim, off);

    return rows.map((r) => rowToTicket(r, workspaceRow.slug));
  }

  function countAll(workspaceRow, filters = {}) {
    // counts 是"整个工作区"的分状态计数（不受 status 过滤影响，前端列头要显示每列总数）
    return workspaceRepo.countsOf(workspaceRow.id);
  }

  function get(idOrRef) {
    const t = requireTicket(idOrRef);
    t.comments = db
      .prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(t.id)
      .map((c) => ({ ...c, model: c.model ?? null }));
    return t;
  }

  /**
   * blocked_by 校验（契约 1.3）：每个 ref 必须形如 {slug}#{seq} 且真实存在。
   * 为什么不只校验格式：AI 会顺着 blocked_by 去查依赖，查到 404 可能误判成"依赖已完成"，
   * 于是把该卡住的活干了。空字符串合法，表示无依赖。
   * @returns {string} 规整后的逗号分隔串
   */
  function assertBlockedBy(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    const refs = text.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = [];
    for (const ref of refs) {
      // 格式与存在性都要查：格式错（"乱写"）和查不到（"nope#999"）对 AI 同样是死引用
      if (!/^.+?#\d+$/.test(ref) || !findByIdOrRef(ref)) bad.push(ref);
    }
    if (bad.length) {
      throw new HttpError(
        400,
        'BLOCKED_BY_INVALID',
        `blocked_by 里有不存在的引用: ${bad.join(', ')}（格式须为 {slug}#{seq}，且工单要真实存在）`,
      );
    }
    return refs.join(',');
  }

  function create(workspaceRow, { title, body, status, priority, blocked_by, position }, actor) {
    const t = assertTitle(title);
    const st = assertStatus(status) || 'open';
    const pr = assertPriority(priority);
    // 先校验再进事务：非法入参不该消耗 seq（虽然事务会回滚，但提前拦更清楚）
    const wanted = assertPosition(position);
    const bodyText = assertBody(body);
    const blocked = assertBlockedBy(blocked_by);
    const now = nowIso();
    const id = newId();

    const created = db.transaction(() => {
      const seq = nextSeq(workspaceRow.id);
      const pos = wanted !== null ? wanted : tailPosition(workspaceRow.id, st);
      db.prepare(
        `INSERT INTO tickets (id, workspace_id, seq, title, body, status, priority, position, blocked_by,
                              actor_id, actor_role, model, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, workspaceRow.id, seq, t, bodyText, st, pr ?? 1, pos,
        blocked, actor.id, actor.role, actor.model ?? null, now, now,
      );
      return seq;
    })();

    return rowToTicket(
      db.prepare('SELECT * FROM tickets WHERE id = ?').get(id),
      workspaceRow.slug,
    );
  }

  function update(idOrRef, patch, actor) {
    const current = requireTicket(idOrRef);
    const sets = [];
    const params = [];

    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(assertTitle(patch.title));
    }
    if (patch.body !== undefined) {
      sets.push('body = ?');
      params.push(assertBody(patch.body));
    }
    if (patch.priority !== undefined) {
      const pr = assertPriority(patch.priority);
      // 显式传了但为空（null/''）：视为"不改"，而不是悄悄重置成普通
      if (pr !== undefined) {
        sets.push('priority = ?');
        params.push(pr);
      }
    }
    if (patch.blocked_by !== undefined) {
      // 传空字符串 = 清空依赖，合法
      sets.push('blocked_by = ?');
      params.push(assertBlockedBy(patch.blocked_by));
    }

    const nextStatus = assertStatus(patch.status);
    const explicitPos = assertPosition(patch.position);
    // 契约 5.5.1：状态迁移要先过合法迁移表，非法直接 400（同状态幂等放行）
    if (nextStatus !== undefined) assertTransition(current.status, nextStatus);

    if (nextStatus !== undefined && nextStatus !== current.status) {
      sets.push('status = ?');
      params.push(nextStatus);
      // 换列时默认落到目标列末尾；显式传 position（拖拽）则尊重传入值
      sets.push('position = ?');
      params.push(explicitPos !== null ? explicitPos : tailPosition(current.workspace_id, nextStatus));
    } else if (explicitPos !== null) {
      sets.push('position = ?');
      params.push(explicitPos);
    }

    if (!sets.length) return current;

    sets.push('updated_at = ?');
    params.push(nowIso());
    params.push(current.id);
    db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const ws = workspaceRepo.find(current.workspace_id);
    return rowToTicket(
      db.prepare('SELECT * FROM tickets WHERE id = ?').get(current.id),
      ws ? ws.slug : '',
    );
  }

  function remove(idOrRef) {
    const t = requireTicket(idOrRef);
    db.transaction(() => {
      db.prepare('DELETE FROM comments WHERE ticket_id = ?').run(t.id); // 显式级联，不依赖外键开关
      db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
    })();
    return { deleted: true, ref: t.ref };
  }

  return { list, get, create, update, remove, findByIdOrRef, requireWorkspace, requireTicket, countAll };
}
