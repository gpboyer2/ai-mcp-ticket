// 工单数据访问。所有写操作走事务，统一维护 updated_at；
// position 的"落到列末尾"逻辑集中在这里，REST / MCP 都调它，避免两套排序规则。
import { newId, nowIso, CLAIM_STALE_MS } from '../db.js';
import { HttpError } from '../actor.js';
import { STATUSES, parseStatusFilter } from './workspaces.js';

export const POSITION_STEP = 1024;

/**
 * 认领是否仍有效（惰性过期）：assignee 非空 且 claimed_at 距今未超过 CLAIM_STALE_MS。
 * 过期即视为「未认领」，读时判定，不需要定时任务。
 * @param {object} r 原始行（含 assignee_id / claimed_at）
 */
function isClaimActive(r) {
  if (!r.assignee_id) return false;
  const claimed = Date.parse(r.claimed_at);
  if (Number.isNaN(claimed)) return false;
  return Date.now() - claimed < CLAIM_STALE_MS;
}

function rowToTicket(r, slug) {
  // 惰性过期：读出的工单若认领已过期，四列按未认领返回（NULL），保证 API / 纯文本视图一致
  const active = isClaimActive(r);
  return {
    id: r.id,
    ref: `${slug}#${r.seq}`,
    workspace_id: r.workspace_id,
    workspace_slug: slug,
    seq: r.seq,
    content: r.content ?? '',
    status: r.status,
    priority: r.priority,
    position: r.position,
    blocked_by: r.blocked_by ?? '',
    actor_id: r.actor_id,
    actor_role: r.actor_role,
    model: r.model ?? null,
    assignee_id: active ? r.assignee_id : null,
    assignee_role: active ? r.assignee_role : null,
    assignee_model: active ? r.assignee_model ?? null : null,
    claimed_at: active ? r.claimed_at : null,
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

// 契约 1.3：content 上限 100000 字。存在意义是防止 AI 或误操作把整份文件贴进来把库撑爆。
// 按字符数（不是 UTF-16 码元）算，中文不会被当成 2 个。
export const CONTENT_MAX = 100000;

/**
 * content 校验（契约 1.3）：trim 后为空即未填，超长直接 400。
 * 返回值是用户原文，不是 trim 后的 —— 首尾空白是 Markdown 缩进的一部分，吃掉就改坏排版。
 */
function assertContent(content) {
  const s = typeof content === 'string' ? content : String(content ?? '');
  if (!s.trim()) throw new HttpError(400, 'CONTENT_REQUIRED', '内容必填');
  const n = [...s].length;
  if (n > CONTENT_MAX) {
    throw new HttpError(400, 'CONTENT_TOO_LONG', `content 最多 ${CONTENT_MAX} 字，收到 ${n} 字`);
  }
  return s;
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
      where.push("t.content LIKE ? ESCAPE '\\'");
      params.push(`%${keyword.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
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

  function create(workspaceRow, { content, status, priority, blocked_by, position }, actor) {
    const text = assertContent(content);
    const st = assertStatus(status) || 'open';
    const pr = assertPriority(priority);
    // 先校验再进事务：非法入参不该消耗 seq（虽然事务会回滚，但提前拦更清楚）
    const wanted = assertPosition(position);
    const blocked = assertBlockedBy(blocked_by);
    const now = nowIso();
    const id = newId();

    const created = db.transaction(() => {
      const seq = nextSeq(workspaceRow.id);
      const pos = wanted !== null ? wanted : tailPosition(workspaceRow.id, st);
      db.prepare(
        `INSERT INTO tickets (id, workspace_id, seq, content, status, priority, position, blocked_by,
                              actor_id, actor_role, model, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, workspaceRow.id, seq, text, st, pr ?? 1, pos,
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

    if (patch.content !== undefined) {
      sets.push('content = ?');
      params.push(assertContent(patch.content));
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
      // 契约 3.2.1：状态改成 done / cancelled 时，同一次 UPDATE 里把认领四字段置 NULL（自动释放）
      if (nextStatus === 'done' || nextStatus === 'cancelled') {
        sets.push('assignee_id = NULL', 'assignee_role = NULL', 'assignee_model = NULL', 'claimed_at = NULL');
      }
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

  // ---------- 认领（锁定）：契约 1.6 / 3.2.1 ----------

  /** 同一 actor 判定：id + role 相同（契约 3.2.1 表格） */
  const isSameActor = (a, b) => !!a && !!b && a.id === b.id && a.role === b.role;

  /** 读原始行（含所有认领字段、含已过期的），供 claim/release/assertWritable 判定，
   *  不受 rowToTicket 的惰性过期屏蔽影响。404 时抛 TICKET_NOT_FOUND。 */
  function requireRawRow(idOrRef) {
    const t = findByIdOrRef(idOrRef);
    if (!t) throw new HttpError(404, 'TICKET_NOT_FOUND', `工单不存在: ${idOrRef}`);
    // findByIdOrRef 返回的是过期归一后的 VO，这里要原始列，所以直接查库
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(t.id);
  }

  /** 当前真实有效的认领者（过期返回 null）；基于原始行 */
  function activeHolder(r) {
    if (!isClaimActive(r)) return null;
    return { id: r.assignee_id, role: r.assignee_role, model: r.assignee_model };
  }

  /** 给认领者造一句"被谁认领"，409 错误信息里要带上（id/role/model + 时间） */
  function claimHolderText(r) {
    const who = r.assignee_role === 'ai'
      ? `ai:${r.assignee_id}${r.assignee_model ? ` (${r.assignee_model})` : ''}`
      : 'user';
    return `${who} 于 ${r.claimed_at} 认领`;
  }

  /**
   * 认领工单（契约 3.2.1）。
   * - 未被认领 / 已过期 → 写入四列（过期接管时 took_over=true）
   * - 同一 actor（id+role）→ 幂等，只刷新 claimed_at
   * - 已被他人认领且未过期 → 409 TICKET_CLAIMED（信息带认领者 id/role/model 与时间）
   * @returns {{ticket:object, took_over:boolean}}
   */
  function claim(idOrRef, actor) {
    const row = requireRawRow(idOrRef);
    const holder = activeHolder(row);
    let tookOver = false;

    if (holder) {
      if (!isSameActor(holder, actor)) {
        throw new HttpError(
          409,
          'TICKET_CLAIMED',
          `工单已被 ${claimHolderText(row)}，你（${actor.role}:${actor.id}）无法认领。` +
            '如需接管，请先让认领者释放，或等待认领过期。',
        );
      }
      // 同一 actor：幂等，只刷新 claimed_at（仍走下面的 UPDATE）
    } else if (row.assignee_id) {
      // 有认领但已过期 → 接管
      tookOver = true;
    }

    const now = nowIso();
    db.prepare(
      `UPDATE tickets SET assignee_id = ?, assignee_role = ?, assignee_model = ?, claimed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(actor.id, actor.role, actor.model ?? null, now, now, row.id);

    const updated = requireTicket(row.id);
    return { ticket: updated, took_over: tookOver };
  }

  /**
   * 释放认领（契约 3.2.1）。
   * - 未被认领 / 已过期 → 幂等 200（无四列可清）
   * - 认领者本人（id+role）→ 释放，四列置 NULL
   * - 调用者 role=user → 可释放任何人的认领（用户是老板）
   * - 其它 AI 且未过期 → 409 TICKET_CLAIMED
   */
  function release(idOrRef, actor) {
    const row = requireRawRow(idOrRef);
    const holder = activeHolder(row);

    if (!holder) return requireTicket(row.id); // 幂等：本就没被有效认领

    if (isSameActor(holder, actor) || actor.role === 'user') {
      db.prepare(
        `UPDATE tickets SET assignee_id = NULL, assignee_role = NULL, assignee_model = NULL,
          claimed_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(nowIso(), row.id);
      return requireTicket(row.id);
    }

    // 其它 AI 且未过期
    throw new HttpError(
      409,
      'TICKET_CLAIMED',
      `工单由 ${claimHolderText(row)}，只有认领者本人或用户（role=user）可释放。`,
    );
  }

  /**
   * 写操作保护（契约 1.6 第 6 条）：已认领且调用者不是认领者时，PATCH / comment_add → 409。
   * 删除工单不在保护范围（契约 1.6 第 7 条：用户的清理动作不能被卡）。
   * 例外：role=user 永远可覆盖。惰性过期：过期认领视为未认领，放行。
   * @throws {HttpError} 409 TICKET_CLAIMED
   */
  function assertWritable(idOrRef, actor) {
    const row = requireRawRow(idOrRef);
    const holder = activeHolder(row);
    if (!holder) return;
    if (isSameActor(holder, actor) || actor.role === 'user') return;
    throw new HttpError(
      409,
      'TICKET_CLAIMED',
      `工单已被 ${claimHolderText(row)}，你（${actor.role}:${actor.id}）不能修改或评论；` +
        '认领者本人或用户（role=user）可操作。',
    );
  }

  return { list, get, create, update, remove, claim, release, assertWritable, findByIdOrRef, requireWorkspace, requireTicket, countAll };
}
