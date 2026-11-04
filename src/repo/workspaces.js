// 工作区只读镜像的数据访问。工作区的增删改只由 workspace-sync 做，这里只查。
import { nowIso } from '../db.js';
import { HttpError } from '../actor.js';

export const STATUSES = ['open', 'in_progress', 'reopened', 'done', 'cancelled'];
export const STATUS_LABEL = {
  open: '打开',
  in_progress: '处理中',
  reopened: '重新打开',
  done: '已完成',
  cancelled: '已取消',
};
export const PRIORITY_LABEL = { 0: '低', 1: '普通', 2: '高', 3: '紧急' };

/**
 * status 过滤值的唯一解析器（REST / 页面 / 文本视图 / MCP 全部走这里）。
 * 非法值必须报 400，不能静默当"全部"：文本视图会输出 `filter: status=all`，
 * AI 会误以为筛选生效了，把全量数据当成筛选结果读，这个误判代价很高。
 * 支持 ?status=a&status=b（数组）与 ?status=a,b（逗号）两种写法。
 * @returns {string[]|null} null 表示"不过滤"
 */
export function parseStatusFilter(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const bad = parts.filter((s) => !STATUSES.includes(s));
  if (bad.length) {
    throw new HttpError(
      400,
      'STATUS_INVALID',
      `未知状态 ${bad.map((s) => `"${s}"`).join(', ')}，合法值: ${STATUSES.join(',')}`,
    );
  }
  return [...new Set(parts)];
}

const emptyCounts = () => ({ open: 0, in_progress: 0, reopened: 0, done: 0, cancelled: 0, total: 0 });

function withCounts(row, counts) {
  // counts 已经是完整的五状态+total，直接复用（countsOf 负责补零与求和）
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    path: row.path,
    archived: !!row.archived,
    ticket_counts: { ...emptyCounts(), ...counts },
    synced_at: row.synced_at,
  };
}

export function createWorkspaceRepo(db) {
  const countStmt = db.prepare(
    'SELECT status, COUNT(*) AS n FROM tickets WHERE workspace_id = ? GROUP BY status',
  );

  /**
   * 工作区全量分状态计数。固定返回五个状态 + total，缺的状态补 0 ——
   * 前端列头要显示"每列总数"，少一个 key 就得在前端补默认值，三处调用方各补一遍必然漂移。
   * 注意：这是整个工作区的计数，不受列表的 status/q 筛选影响。
   */
  function countsOf(workspaceId) {
    const out = emptyCounts();
    for (const r of countStmt.all(workspaceId)) {
      if (r.status in out) out[r.status] = r.n;
    }
    out.total = STATUSES.reduce((n, s) => n + out[s], 0);
    return out;
  }

  /** ws 可为 id 或 slug；归档工作区仍可访问（有工单挂靠） */
  function find(ws) {
    if (!ws) return null;
    const row =
      db.prepare('SELECT * FROM workspaces WHERE id = ? OR slug = ?').get(ws, ws) || null;
    return row;
  }

  function list({ includeArchived = false } = {}) {
    const rows = db
      .prepare(
        `SELECT * FROM workspaces ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived ASC, title COLLATE NOCASE ASC`,
      )
      .all();
    return rows.map((r) => withCounts(r, countsOf(r.id)));
  }

  function toApi(row) {
    return row ? withCounts(row, countsOf(row.id)) : null;
  }

  /** 新建/更新一条工作区（由 sync 调用）。slug 一旦定下不再变，因为 ref 里带着它 */
  function upsert({ id, slug, title, path }) {
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    const now = nowIso();
    if (!existing) {
      db.prepare(
        `INSERT INTO workspaces (id, slug, title, path, archived, synced_at) VALUES (?,?,?,?,0,?)`,
      ).run(id, slug, title, path, now);
      return { added: true, updated: false };
    }
    const changed = existing.title !== title || existing.path !== path || existing.archived !== 0;
    if (!changed) {
      // 内容没变也要刷 synced_at，前端靠它判断"镜像是不是活的"
      db.prepare('UPDATE workspaces SET synced_at = ? WHERE id = ?').run(now, id);
      return { added: false, updated: false };
    }
    // slug 冲突时这里可能抛 UNIQUE，交给调用方兜底；archived 复活回 0
    db.prepare('UPDATE workspaces SET title = ?, path = ?, archived = 0, synced_at = ? WHERE id = ?').run(
      title,
      path,
      now,
      id,
    );
    return { added: false, updated: true };
  }

  function archiveMissing(seenIds) {
    const all = db.prepare('SELECT id FROM workspaces WHERE archived = 0').all();
    const keep = new Set(seenIds);
    const stmt = db.prepare('UPDATE workspaces SET archived = 1, synced_at = ? WHERE id = ?');
    const now = nowIso();
    let n = 0;
    for (const r of all) {
      if (!keep.has(r.id)) n += stmt.run(now, r.id).changes;
    }
    return n;
  }

  function slugTaken(slug, exceptId) {
    const row = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug);
    return !!row && row.id !== exceptId;
  }

  return { find, list, toApi, upsert, archiveMissing, slugTaken, countsOf };
}
