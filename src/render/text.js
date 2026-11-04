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

/** 多行文本缩进：首行跟在前缀后面，后续行按同样宽度对齐，避免破坏段落结构。
 *  空行不补缩进空格——纯空白行给 AI 读没有任何信息，只白烧 token。 */
function indentBlock(text, prefix, contIndent) {
  const lines = String(text ?? '').split('\n');
  return [
    prefix + lines[0],
    ...lines.slice(1).map((l) => (l.trim() ? contIndent + l : '')),
  ].join('\n');
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
 * @param {number} [p.maxlen]    内容截断长度，0=不截断
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
    lines.push(
      `    by: ${actorLabel(t.actor_id, t.actor_role, t.model)} at ${t.created_at}`,
    );
    if (t.blocked_by) lines.push(`    blocked_by: ${t.blocked_by}`);
    // 契约 1.6 / 4.2：已认领（且未过期）的工单多一行，让 AI 读列表时就知道"这张被占了，别动"
    if (t.assignee_id) {
      lines.push(`    assignee: ${actorLabel(t.assignee_id, t.assignee_role, t.assignee_model)} since ${t.claimed_at}`);
    }
    // 工单只有 content 一个内容字段（契约 1.3）：不再有 title/body 两行，多行按 6 空格对齐
    if (t.content && t.content.trim()) {
      lines.push(indentBlock(truncate(t.content, maxlen), '    content: ', '      '));
    }
    if (t.comments && t.comments.length) {
      lines.push(...commentsBlock(t.comments, { comments }));
    }
    lines.push('');
  });

  // 契约 5.5.4：读侧漏网标记，放在 # end. 之前（只标记，不改任何数据）
  lines.push(...missedStatusLines(tickets, lines[lines.length - 1] === ''));

  lines.push('# end. 用 ?status= 过滤，?format=text 强制纯文本');
  return lines.join('\n') + '\n';
}

// 完工词表（契约 5.5.4）。只用于读侧标记，**绝不触发状态变更** —— 词表猜错会改坏数据，
// 而漏判只是少提醒一次，下一轮读列表还能看见。
//
// 为什么不含裸英文 done / fixed / resolved：在这个项目里它们几乎总是在**讨论状态值本身**
// （`done → reopened`、`status=done`、`done=circle-check`）或 CSS 的 `position: fixed`，
// 不是完工声明。拿真实库 41 条 AI 评论量过：带裸英文词命中 14 条，其中 6 条是这种元文本
// （误报 43%）；只留中文完工词并要求出现在句首/行首后命中 7 条，全部是真完工报告。
// 宁可少报（漏了下轮读列表还能看见），不可乱报 —— 乱报的提醒会和旧 statusHint 一样被无视。
const DONE_WORDS = /(?:^|[。！\n])\s*(?:已完成|搞定了|已修复|已解决|修好了)|^\s*#{1,6}\s*(?:完成情况|做完的动作|验收结果)/m;

/** 该补的状态档位：done = 可能漏收尾，in_progress = 可能漏开工 */
const NEEDS = {
  done: {
    text: '可能漏了 status=done（评论像是完工报告，状态还没改成已完成）',
    // reopened 不能直达 done（契约 5.5.1：reopened → in_progress | cancelled | reopened），
    // 文案必须把中转那一步说出来，否则 AI 照着调会吃 400 TRANSITION_INVALID
    fix: '确认做完就调 ticket_update status=done（若是 reopened 的单，先改 in_progress 再改 done）',
  },
  in_progress: {
    text: '漏了 status=in_progress（AI 已经在上面写过评论，状态还停在打开）',
    fix: '开始处理了就调 ticket_update status=in_progress',
  },
};

/**
 * 单张工单该补什么状态（契约 5.5.4）。只标记，不改任何数据。
 *
 * 三种漏网都要抓，因为用户抱怨的就是这几种：
 * - `in_progress` / `reopened` 且最后一条 AI 评论像完工报告 → 漏了 done
 * - `open` 且**有任何** AI 评论 → 漏了 in_progress。这是历史遗留最多的一类
 *   （ai-剧本#60 就是：评论写着「做完的动作」，状态还停在打开），
 *   也是 in_progress→open 被合法挪回去之后的形态。
 *
 * 只看最后一条 **AI** 评论，不看最后一条评论：用户事后追一句「收到」不该把 AI 的完工
 * 报告盖掉，而 AI 说完「已修复」又补一句「又发现边界问题」时，确实不该再催它收尾。
 * @param {object} t 工单（含 status / ref / comments）
 * @returns {'done'|'in_progress'|null}
 */
function missedStatusKind(t) {
  const aiComments = (t.comments || []).filter((c) => c.actor_role === 'ai');
  if (!aiComments.length) return null;

  if (t.status === 'open') return 'in_progress'; // open 单上有 AI 评论 = 干过活却没开工
  if (t.status !== 'in_progress' && t.status !== 'reopened') return null;

  const last = aiComments[aiComments.length - 1];
  return DONE_WORDS.test(String(last.body ?? '')) ? 'done' : null;
}

/**
 * 读侧漏网标记（契约 5.5.4）：只标记，不改数据。
 * 两种原因分两行写，不混排 —— 混在一行里就说不清哪张该补 done、哪张该补 in_progress，
 * 而「补错状态」比「不提醒」更糟。都放在 `# end.` 之前。
 * @param {Array} tickets 本次列表里的工单（含 comments）
 * @param {boolean} alreadyBlank 正文末尾是否已经是空行（每张工单块后面都跟一个空行）
 * @returns {string[]} 需要追加的行（含分隔空行），没有漏网时返回空数组
 */
function missedStatusLines(tickets, alreadyBlank) {
  const byKind = { done: [], in_progress: [] };
  for (const t of tickets) {
    const kind = missedStatusKind(t);
    if (kind) byKind[kind].push(t.ref);
  }
  const lines = [];
  for (const kind of ['done', 'in_progress']) {
    const refs = byKind[kind];
    if (!refs.length) continue;
    // 空行只为分隔：正文末尾已经是空行就不再叠一个，两档之间才补
    if (!lines.length ? !alreadyBlank : true) lines.push('');
    lines.push(`# 待办: ${refs.join(' ')} ${NEEDS[kind].text}。${NEEDS[kind].fix}`);
  }
  return lines;
}

/**
 * 锁定提醒（契约 5.5.6）。为什么要有它：AI 读列表时该看到「这张被别人占了」，
 * 而不是动手改到一半被 409 顶回来。这条提醒只在写操作的返回里出现，读操作不打扰。
 * @param {object} ticket 含 assignee_* 与 claimed_at
 * @param {{id:string, role:'user'|'ai'}} actor 本次调用者
 * @returns {string|null}
 */
export function claimLockHint(ticket, actor) {
  if (!ticket || !ticket.assignee_id) return null;
  // 自己占的不提醒；用户是老板，不受锁约束，也不用提醒
  if (actor && actor.role === 'user') return null;
  if (actor && ticket.assignee_id === actor.id && ticket.assignee_role === actor.role) return null;
  const who = actorLabel(ticket.assignee_id, ticket.assignee_role, ticket.assignee_model);
  return `# 锁定提醒: 该工单已被 ${who} 于 ${ticket.claimed_at} 认领，请勿修改或评论`;
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

  lines.push('', '## 内容');
  const content = (ticket.content || '').trim();
  lines.push(content ? truncate(content, maxlen) : '(空)');

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

  // 锁定提醒（契约 5.5.6）放在 # end. 之前，同一个 # 前缀，保持纯文本一致性
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
