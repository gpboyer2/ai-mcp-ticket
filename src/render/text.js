// 纯文本渲染的唯一实现（契约 4.2 / 4.3）。
// REST 的 text 视图、页面路由的 .txt 形态、MCP 工具全部调这里 —— 三处各写一套格式必然漂移。
import { STATUS_LABEL, PRIORITY_LABEL } from '../repo/workspaces.js';

const DEFAULT_MAXLEN = 800;

/** actor 展示：ai 带模型（审计需要），user 只有身份 */
export function actorLabel(actorId, actorRole, model) {
  return actorRole === 'ai' ? `ai:${actorId} (${model ?? '未知模型'})` : 'user';
}

const charLen = (s) => [...s].length;

/** 按字符（不是 UTF-16 码元）截断，中文不会被切成半个 */
export function truncate(text, maxlen) {
  const s = String(text ?? '');
  const limit = Number(maxlen);
  if (!Number.isFinite(limit) || limit <= 0) return s; // 0 / 负数 = 不截断
  if (charLen(s) <= limit) return s;
  return [...s].slice(0, limit).join('') + '…(截断)';
}

/** 多行文本缩进：首行跟在前缀后面，后续行按同样宽度对齐，避免破坏段落结构 */
function indentBlock(text, prefix, contIndent) {
  const lines = String(text ?? '').split('\n');
  return [prefix + lines[0], ...lines.slice(1).map((l) => contIndent + l)].join('\n');
}

function commentsBlock(comments, { comments: commentLimit, indent = '    ' }) {
  const total = comments.length;
  if (commentLimit === 0) return []; // ?comments=0 完全隐藏
  if (!total) return [];

  const limit = Number(commentLimit);
  const shown = Number.isFinite(limit) && limit > 0 ? comments.slice(-limit) : comments;
  const out = [];
  if (shown.length < total) {
    out.push(`${indent}comments(共 ${total} 条，仅显示最后 ${shown.length} 条):`);
  } else {
    out.push(`${indent}comments(${total}):`);
  }
  for (const c of shown) {
    const who = actorLabel(c.actor_id, c.actor_role, c.model);
    out.push(indentBlock(c.body, `${indent}  - ${c.created_at} ${who}: `, `${indent}    `));
  }
  return out;
}

/**
 * 列表提示行（契约 4.2）。给完整 URL 而不是相对路径：AI 拿到 host 之外的文本时
 * 还得猜域名端口，猜错就白跑一趟。host 由调用方从请求里取（局域网访问时就是局域网地址）。
 * baseUrl 为空（MCP 无 HTTP 上下文）时退化为相对路径，总比给个错的 host 强。
 */
function listHint(slug, baseUrl) {
  const base = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  return (
    `读 ${base}/${slug}/list.txt?status=open,in_progress,reopened 拿最新；` +
    `写评论用 POST ${base}/api/tickets/{id}/comments，需带 X-Actor-Id/X-Actor-Role/X-Actor-Model`
  );
}

/**
 * 列表纯文本（契约 4.2）
 * @param {object} p
 * @param {object} p.workspace   {slug,title,path}
 * @param {Array}  p.tickets     repo 出来的工单（含 ref）
 * @param {string[]|null} p.statuses 生效的状态过滤
 * @param {number} [p.maxlen]    正文截断长度，0=不截断
 * @param {number} [p.comments]  只显示最后 N 条评论，0=隐藏
 * @param {string} [p.generatedAt]
 */
export function renderTicketList({
  workspace,
  tickets,
  statuses = null,
  maxlen = DEFAULT_MAXLEN,
  comments,
  generatedAt = new Date().toISOString(),
  baseUrl = '',
}) {
  const lines = [`# ai-mcp-ticket  workspace: ${workspace.slug}  path: ${workspace.path}`];
  // 没带 status 时连 `filter:` 标签一起去掉：`# filter: count: 2` 双冒号读起来像笔误，
  // 而且"没有过滤"这件事本身不需要占一个词。
  const tail = `count: ${tickets.length}  generated: ${generatedAt}`;
  lines.push(statuses && statuses.length ? `# filter: status=${statuses.join(',')}  ${tail}` : `# ${tail}`);
  lines.push(`# 提示: ${listHint(workspace.slug, baseUrl)}`);
  lines.push('');

  tickets.forEach((t, i) => {
    const prio = PRIORITY_LABEL[t.priority] ?? String(t.priority);
    lines.push(
      `[${i + 1}] ${t.ref}  ${STATUS_LABEL[t.status] ?? t.status}  优先级:${prio}  更新:${t.updated_at}`,
    );
    lines.push(`    title: ${t.title}`);
    lines.push(
      `    by: ${actorLabel(t.actor_id, t.actor_role, t.model)} at ${t.created_at}`,
    );
    if (t.blocked_by) lines.push(`    blocked_by: ${t.blocked_by}`);
    // 契约 1.6 / 4.2：已认领（且未过期）的工单多一行，让 AI 读列表时就知道"这张被占了，别动"
    if (t.assignee_id) {
      lines.push(`    assignee: ${actorLabel(t.assignee_id, t.assignee_role, t.assignee_model)} since ${t.claimed_at}`);
    }
    if (t.body && t.body.trim()) {
      lines.push(indentBlock(truncate(t.body, maxlen), '    body: ', '      '));
    }
    if (t.comments && t.comments.length) {
      lines.push(...commentsBlock(t.comments, { comments }));
    }
    lines.push('');
  });

  lines.push('# end. 用 ?status= 过滤，?format=text 强制纯文本');
  return lines.join('\n') + '\n';
}

// 完工词表（契约 5.5.2）。不区分大小写，中英文都覆盖。
const DONE_WORDS = /已完成|搞定了|已修复|已解决|修好了|done|fixed|resolved/i;

/**
 * 状态提醒（契约 5.5.2）。软约束：AI 不是不听话，是没人提醒它。
 * 只在"本次是写操作"时由调用方传入 event，读操作不传 → 不产生提醒（否则每次读多一行就是噪音）。
 * @param {object} p
 * @param {string} p.status    写入后的工单状态
 * @param {'comment_add'|'ticket_create'} [p.event] 本次写操作类型；读操作不传
 * @param {string} [p.body]    本次写入的正文（判断"完工报告"用）
 * @param {'user'|'ai'} [p.actorRole]
 * @returns {string|null} 需要追加的提醒行（不含换行），无需提醒时返回 null
 */
export function statusHint({ status, event, body = '', actorRole = 'ai' } = {}) {
  if (!event) return null; // 读操作一律不加

  if (event === 'ticket_create') {
    // 只有 AI 建单才提醒：用户建单后自己会推进状态，提醒他是噪音
    if (actorRole === 'ai' && status === 'open') {
      return '# 状态提醒: 新建的工单是「打开」。开始处理时请调 ticket_update status=in_progress';
    }
    return null;
  }

  if (event === 'comment_add') {
    if (status === 'open' && actorRole === 'ai') {
      return '# 状态提醒: 该工单仍是「打开」。若你已开始处理，请调 ticket_update status=in_progress';
    }
    if (status === 'in_progress' && DONE_WORDS.test(body)) {
      return '# 状态提醒: 评论像是完工报告。若确实已完成，请调 ticket_update status=done';
    }
    return null;
  }

  return null;
}

/** 单张工单纯文本（契约 4.3） */
export function renderTicket(ticket, { maxlen = 0, workspace, hint = null, baseUrl = '' } = {}) {
  const ws = workspace || { slug: ticket.workspace_slug, path: ticket.workspace_path };
  const prio = PRIORITY_LABEL[ticket.priority] ?? String(ticket.priority);
  const lines = [
    `# ai-mcp-ticket ticket: ${ticket.ref}`,
    `status: ${STATUS_LABEL[ticket.status] ?? ticket.status} (${ticket.status})   priority: ${prio} (${ticket.priority})   position: ${ticket.position}`,
    `workspace: ${ws.slug}  path: ${ws.path}`,
    `created: ${ticket.created_at} by ${actorLabel(ticket.actor_id, ticket.actor_role, ticket.model)}`,
    `updated: ${ticket.updated_at}`,
  ];
  if (ticket.blocked_by) lines.push(`blocked_by: ${ticket.blocked_by}`);
  // 契约 1.6 / 4.3：已认领（且未过期）多一行 assignee
  if (ticket.assignee_id) {
    lines.push(`assignee: ${actorLabel(ticket.assignee_id, ticket.assignee_role, ticket.assignee_model)} since ${ticket.claimed_at}`);
  }
  lines.push(`id: ${ticket.id}`);

  lines.push('', '## 正文');
  const body = (ticket.body || '').trim();
  lines.push(body ? truncate(body, maxlen) : '(空)');

  const comments = ticket.comments || [];
  lines.push('', `## 评论 (${comments.length})`);
  if (!comments.length) {
    lines.push('(暂无评论)');
  } else {
    for (const c of comments) {
      lines.push(`- [${c.created_at}] ${actorLabel(c.actor_id, c.actor_role, c.model)}`);
      lines.push(indentBlock(truncate(c.body, maxlen), '  ', '  '));
    }
  }

  // 提醒行放在 # end. 之前，同一个 # 前缀，保持纯文本一致性
  if (hint) lines.push('', hint);
  const base = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  lines.push(
    '',
    `# end. 写评论用 POST ${base}/api/tickets/${ticket.id}/comments，需带 X-Actor-Id/X-Actor-Role/X-Actor-Model`,
  );
  return lines.join('\n') + '\n';
}

/** 工作区索引纯文本（`GET /` 的 text 形态） */
export function renderWorkspaceIndex({ workspaces, generatedAt = new Date().toISOString(), baseUrl = '' }) {
  const base = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  const lines = [
    '# ai-mcp-ticket 工作区索引',
    `# count: ${workspaces.length}  generated: ${generatedAt}`,
    // 不引用 docs：开源用户装完 MCP 手里没有我们的文档，指过去是废话还费 token
    `# 提示: 读 ${base}/{ws}/list.txt 看某工作区工单；status 可选 open,in_progress,reopened,done,cancelled`,
    '',
  ];
  workspaces.forEach((w, i) => {
    const c = w.ticket_counts || {};
    lines.push(`[${i + 1}] ${w.slug}  ${w.archived ? '(已归档) ' : ''}${w.title}`);
    lines.push(`    path: ${w.path}`);
    lines.push(
      `    tickets: 打开 ${c.open || 0} / 处理中 ${c.in_progress || 0} / 重新打开 ${c.reopened || 0} / 已完成 ${c.done || 0} / 已取消 ${c.cancelled || 0}  共 ${c.total || 0}`,
    );
    lines.push(`    list: ${base}/${w.slug}/list.txt`);
    lines.push('');
  });
  lines.push('# end. 用 ?status= 过滤，?format=text 强制纯文本');
  return lines.join('\n') + '\n';
}

/** 评论纯文本（MCP comment_list 用） */
export function renderCommentList(ticket, comments) {
  const lines = [
    `# ai-mcp-ticket comments: ${ticket.ref}  (${comments.length})`,
    '',
  ];
  if (!comments.length) lines.push('(暂无评论)');
  for (const c of comments) {
    lines.push(`- [${c.created_at}] ${actorLabel(c.actor_id, c.actor_role, c.model)}`);
    lines.push(`  id: ${c.id}`);
    lines.push(indentBlock(c.body, '  ', '  '));
    lines.push('');
  }
  lines.push('# end.');
  return lines.join('\n') + '\n';
}

/**
 * 纯文本错误说明（页面路由出错时用，Content-Type 仍是 text/plain）。
 * 带上真实状态码与错误码，别一律写 404 —— 400 的入参错误写成 404 会把人带偏。
 */
export function renderNotFound(message, { status = 404, code = 'NOT_FOUND' } = {}) {
  return `# ai-mcp-ticket ${status} ${code}\n${message}\n# end.\n`;
}

export { DEFAULT_MAXLEN };
