// 纯文本渲染单测（契约 4.2 / 4.3）。
// 直接测 src/render/text.js，不经过 HTTP —— 格式一旦漂移，这里是第一道也是最快的报警线。
// 断言全部对着契约 4.2 的样例逐行核对，不写"只要跑通"的弱断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTicketList,
  renderTicket,
  renderWorkspaceIndex,
  renderCommentList,
  actorLabel,
  truncate,
  absolutizeUploads,
  DEFAULT_MAXLEN,
} from '../src/render/text.js';

const WS = { slug: 'demo-project', path: '/path/to/your/workspace/demo-project' };

/** 造一张符合 repo 输出形状的工单 */
function ticket(over = {}) {
  return {
    id: '6f1c0000-0000-4000-8000-000000000001',
    ref: 'demo-project#12',
    workspace_id: 'ws-1',
    workspace_slug: 'demo-project',
    seq: 12,
    // 工单只有 content 一个内容字段（契约 1.3）：第一行是卡片预览，后面是内容的其余部分。
    // 这里用契约 4.2 样例的形态（两行内容），断言才能逐行对上契约。
    content: '修复回测空指针\n复现步骤 1) ... 2) ...',
    status: 'open',
    priority: 2,
    position: 1024,
    blocked_by: 'demo-project#11',
    actor_id: 'deepseek',
    actor_role: 'ai',
    model: 'deepseek-v4.1',
    created_at: '2026-11-04T03:00:00.000Z',
    updated_at: '2026-11-04T03:20:00.000Z',
    comments: [
      {
        id: 'c1',
        ticket_id: '6f1c0000-0000-4000-8000-000000000001',
        body: '已定位到 xxx',
        actor_id: 'deepseek',
        actor_role: 'ai',
        model: 'deepseek-v4.1',
        created_at: '2026-11-04T03:10:00.000Z',
        updated_at: '2026-11-04T03:10:00.000Z',
      },
      {
        id: 'c2',
        ticket_id: '6f1c0000-0000-4000-8000-000000000001',
        body: '再加一条要求 yyy',
        actor_id: 'user',
        actor_role: 'user',
        model: null,
        created_at: '2026-11-04T03:15:00.000Z',
        updated_at: '2026-11-04T03:15:00.000Z',
      },
    ],
    ...over,
  };
}

test('4.2 列表格式：首行 / filter 行 / 提示行 / 条目 / 结尾，逐条对齐契约', () => {
  const out = renderTicketList({
    workspace: WS,
    tickets: [ticket()],
    statuses: ['open', 'in_progress'],
    generatedAt: '2026-11-04T03:21:00.000Z',
  });
  const lines = out.split('\n');

  // 首行：契约 4.2 是双空格分隔
  assert.equal(
    lines[0],
    '# ai-mcp-ticket  workspace: demo-project  path: /path/to/your/workspace/demo-project',
    '首行必须是 `# ai-mcp-ticket  workspace: {slug}  path: {path}`',
  );
  // 第二行：filter / count / generated
  assert.equal(
    lines[1],
    '# filter: status=open,in_progress  count: 1  generated: 2026-11-04T03:21:00.000Z',
    '第二行必须是 filter + count + generated',
  );
  // 第三行提示：必须告诉 AI 怎么写评论（否则 AI 不知道要带身份头）
  assert.match(lines[2], /^# 提示: /, '第三行必须是提示行');
  assert.ok(lines[2].includes('X-Actor-Id'), '提示里必须提到 X-Actor-Id（AI 靠它知道怎么写）');
  assert.equal(lines[3], '', '提示行后要空一行');

  // 条目首行：`[1] ref  状态  优先级:X  更新:ISO`
  assert.equal(
    lines[4],
    '[1] demo-project#12  打开  优先级:高  更新:2026-11-04T03:20:00.000Z',
    '条目首行必须是 `[n] ref  中文状态  优先级:X  更新:ISO`（双空格分隔）',
  );
  assert.equal(
    lines[5],
    '    by: ai:deepseek (deepseek-v4.1) at 2026-11-04T03:00:00.000Z',
    'by 行必须是 `    by: ai:{id} ({model}) at {created_at}`',
  );
  assert.equal(lines[6], '    blocked_by: demo-project#11', 'blocked_by 有值才输出');
  assert.equal(lines[7], '    content: 修复回测空指针', 'content 行必须是 `    content: ` 前缀（首行）');
  assert.equal(lines[8], '      复现步骤 1) ... 2) ...', 'content 续行缩进 6 空格，与内容对齐');
  assert.equal(lines[9], '    comments(2):', 'comments 块头必须是 `    comments(N):`');
  assert.equal(
    lines[10],
    '      - 2026-11-04T03:10:00.000Z ai:deepseek (deepseek-v4.1): 已定位到 xxx',
    'AI 评论必须带 model（审计需要）',
  );
  assert.equal(
    lines[11],
    '      - 2026-11-04T03:15:00.000Z user: 再加一条要求 yyy',
    'user 评论只显示 user，不显示 null model',
  );
  // 末尾固定行
  assert.ok(
    out.trimEnd().endsWith('# end. 用 ?status= 过滤，?format=text 强制纯文本'),
    '文件末尾必须固定输出 `# end. ...`',
  );
  // 以换行结尾（AI 读文件时末行不被吃掉）
  assert.ok(out.endsWith('\n'), '输出必须以换行结尾');
});

test('4.2 空字段不输出那一行（content 为空则不打 content 行）', () => {
  const out = renderTicketList({
    workspace: WS,
    tickets: [ticket({ content: '', blocked_by: '', comments: [] })],
    statuses: ['open'],
  });
  assert.ok(!out.includes('content:'), 'content 为空时不能输出空的 content 行（省 token）');
  assert.ok(!out.includes('blocked_by:'), 'blocked_by 为空时不能输出该行');
  assert.ok(!out.includes('comments('), '没有评论时不能输出空的 comments 块');
  // 但 by 这些必有的字段还在
  assert.ok(out.includes('    by: '));
});

test('4.2 maxlen 截断：默认 800，?maxlen=0 不截断，超长加 …(截断)', () => {
  assert.equal(DEFAULT_MAXLEN, 800, '契约 4.2 规定默认 maxlen=800');

  const long = '一'.repeat(1000);
  // 默认截断
  const def = renderTicketList({ workspace: WS, tickets: [ticket({ content: long, comments: [] })], statuses: ['open'] });
  const contentLine = def.split('\n').find((l) => l.startsWith('    content: '));
  assert.ok(contentLine.endsWith('…(截断)'), '超过 maxlen 必须加 `…(截断)` 标记');
  const keptChars = [...contentLine.replace('    content: ', '').replace('…(截断)', '')].length;
  assert.equal(keptChars, 800, `默认应保留 800 字，实际 ${keptChars}`);

  // maxlen=0 不截断
  const noTrunc = renderTicketList({
    workspace: WS,
    tickets: [ticket({ content: long, comments: [] })],
    statuses: ['open'],
    maxlen: 0,
  });
  assert.ok(!noTrunc.includes('…(截断)'), 'maxlen=0 表示不截断（契约 4.2）');
  assert.ok(noTrunc.includes(long), 'maxlen=0 时内容必须完整保留');

  // 自定义 maxlen
  const m10 = renderTicketList({
    workspace: WS,
    tickets: [ticket({ content: '一二三四五六七八九十', comments: [] })],
    statuses: ['open'],
    maxlen: 5,
  });
  assert.ok(m10.includes('    content: 一二三四五…(截断)'), 'maxlen=5 应只留前 5 个字');

  // 正好等于 maxlen 时不截断（边界）
  const exact = renderTicketList({
    workspace: WS,
    tickets: [ticket({ content: '一二三四五', comments: [] })],
    statuses: ['open'],
    maxlen: 5,
  });
  assert.ok(!exact.includes('…(截断)'), '正好等于 maxlen 时不应截断');

  // 中文按字符截断，不能切出半个字
  const cn = truncate('中文测试', 2);
  assert.equal(cn, '中文…(截断)', '必须按 Unicode 字符截断，不能按 UTF-16 码元');
});

test('4.2 comments=N 只显示最后 N 条，并注明共 N 条', () => {
  const comments = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    ticket_id: 't',
    body: `第 ${i + 1} 条`,
    actor_id: 'user',
    actor_role: 'user',
    model: null,
    created_at: `2026-11-04T03:0${i}:00.000Z`,
    updated_at: `2026-11-04T03:0${i}:00.000Z`,
  }));

  // comments=2 → 只留最后 2 条，块头注明
  const two = renderTicketList({
    workspace: WS,
    tickets: [ticket({ comments })],
    statuses: ['open'],
    comments: 2,
  });
  assert.ok(
    two.includes('    comments(共 5 条，仅显示最后 2 条):'),
    '契约 4.2 要求注明 `(共 N 条，仅显示最后 N 条)`',
  );
  assert.ok(two.includes('第 4 条'), '应显示倒数第二条');
  assert.ok(two.includes('第 5 条'), '应显示最后一条');
  assert.ok(!two.includes('第 1 条'), '更早的评论必须被隐藏（省 token）');

  // comments=0 → 完全隐藏
  const zero = renderTicketList({
    workspace: WS,
    tickets: [ticket({ comments })],
    statuses: ['open'],
    comments: 0,
  });
  assert.ok(!zero.includes('comments('), 'comments=0 时完全不输出评论块');
  assert.ok(!zero.includes('第 5 条'));

  // 不传 → 全部显示
  const all = renderTicketList({ workspace: WS, tickets: [ticket({ comments })], statuses: ['open'] });
  assert.ok(all.includes('    comments(5):'), '默认显示全部评论');
  for (let i = 1; i <= 5; i++) assert.ok(all.includes(`第 ${i} 条`), `默认应包含第 ${i} 条`);

  // 显示条数大于总数时，不出现"仅显示"字样（不能误导 AI）
  const more = renderTicketList({
    workspace: WS,
    tickets: [ticket({ comments })],
    statuses: ['open'],
    comments: 99,
  });
  assert.ok(more.includes('    comments(5):'), '要求的条数超过总数时显示实际总数');
  assert.ok(!more.includes('仅显示'), '没有截断时不能出现"仅显示"');
});

test('4.2 多行内容缩进对齐，不破坏段落结构', () => {
  const out = renderTicketList({
    workspace: WS,
    tickets: [ticket({ content: '第一行\n第二行\n第三行', comments: [] })],
    statuses: ['open'],
  });
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.startsWith('    content: '));
  assert.equal(lines[i], '    content: 第一行');
  assert.equal(lines[i + 1], '      第二行', '续行应缩进 6 空格，与 content 内容对齐');
  assert.equal(lines[i + 2], '      第三行');
});

test('4.3 单张工单纯文本格式', () => {
  const out = renderTicket(ticket(), { workspace: WS });
  const lines = out.split('\n');
  assert.equal(lines[0], '# ai-mcp-ticket ticket: demo-project#12', '首行必须是 `# ai-mcp-ticket ticket: {ref}`');
  assert.equal(
    lines[1],
    'status: 打开 (open)   priority: 高 (2)   position: 1024',
    '状态行必须同时给中文和英文值（AI 用英文值，人看中文）',
  );
  assert.equal(
    lines[2],
    'workspace: demo-project  path: /path/to/your/workspace/demo-project',
    'workspace 行必须带 path',
  );
  assert.equal(
    lines[3],
    'created: 2026-11-04T03:00:00.000Z by ai:deepseek (deepseek-v4.1)',
    'created 行必须带创建者与 model',
  );
  assert.equal(lines[4], 'updated: 2026-11-04T03:20:00.000Z');
  assert.equal(lines[5], 'blocked_by: demo-project#11');
  assert.equal(lines[6], 'id: 6f1c0000-0000-4000-8000-000000000001', 'id 行必须给 uuid（AI 写评论要用）');

  const contentIdx = lines.indexOf('## 内容');
  assert.ok(contentIdx > 0, '必须有 `## 内容` 段（契约 4.3）');
  assert.equal(lines[contentIdx + 1], '修复回测空指针', 'content 第一行也要原样给出，不能只给正文');
  assert.equal(lines[contentIdx + 2], '复现步骤 1) ... 2) ...', 'content 必须整份给出，不丢行');

  const cmtIdx = lines.indexOf('## 评论 (2)');
  assert.ok(cmtIdx > 0, '必须有 `## 评论 (N)` 段，N 是真实条数');
  assert.equal(lines[cmtIdx + 1], '- [2026-11-04T03:10:00.000Z] ai:deepseek (deepseek-v4.1)');
  assert.equal(lines[cmtIdx + 2], '  已定位到 xxx', '评论正文缩进 2 空格');
  assert.equal(lines[cmtIdx + 3], '- [2026-11-04T03:15:00.000Z] user');
  assert.ok(out.includes('# end.'), '必须有结尾行');
});

test('4.3 空内容 / 无评论时有明确占位，不留空行让 AI 猜', () => {
  const out = renderTicket(ticket({ content: '', comments: [] }), { workspace: WS });
  assert.ok(out.includes('## 内容\n(空)'), '内容为空应写 (空)，而不是留一片空白');
  assert.ok(out.includes('## 评论 (0)'), '无评论时仍要给出条数 0');
  assert.ok(out.includes('(暂无评论)'), '无评论时要有明确占位');
});

test('工作区索引纯文本：每个工作区带各状态计数', () => {
  const out = renderWorkspaceIndex({
    workspaces: [
      {
        id: 'w1',
        slug: 'demo',
        title: '示例项目',
        path: '/tmp/demo',
        archived: false,
        ticket_counts: { open: 2, in_progress: 1, reopened: 0, done: 3, cancelled: 1, total: 7 },
      },
    ],
    generatedAt: '2026-11-04T03:21:00.000Z',
  });
  assert.ok(out.startsWith('# ai-mcp-ticket 工作区索引'), '首行标识产品');
  assert.ok(out.includes('# count: 1  generated: 2026-11-04T03:21:00.000Z'), '要有总数与生成时间');
  assert.ok(out.includes('[1] demo  示例项目'), '条目要有序号 + slug + 标题');
  assert.ok(out.includes('    path: /tmp/demo'), '要带 path（AI 靠它定位项目）');
  assert.ok(out.includes('打开 2'), '要显示打开数');
  assert.ok(out.includes('已完成 3'));
  assert.ok(out.includes('共 7'), '要显示总数');
  assert.ok(out.includes('    list: /demo/list'), '要给出 list URL，省得 AI 自己拼');
  assert.ok(out.trimEnd().endsWith('# end. 用 ?status= 过滤，?format=text 强制纯文本'));
});

test('actorLabel：ai 带 model，user 只显示 user，缺 model 有兜底', () => {
  assert.equal(actorLabel('deepseek', 'ai', 'deepseek-v4.1'), 'ai:deepseek (deepseek-v4.1)');
  assert.equal(actorLabel('user', 'user', null), 'user', 'user 不能显示 (null)');
  assert.equal(actorLabel('x', 'ai', null), 'ai:x (未知模型)', 'AI 缺 model 时要有可读兜底，不能显示 null');
});

test('truncate 边界：0 / 负数 / 非数字 / 空串 / 正好等长', () => {
  assert.equal(truncate('abc', 0), 'abc', 'maxlen=0 表示不截断');
  assert.equal(truncate('abc', -1), 'abc', '负数视同不截断');
  assert.equal(truncate('abc', NaN), 'abc', '非数字视同不截断');
  assert.equal(truncate('abc', 3), 'abc', '正好等长不截断');
  assert.equal(truncate('abcd', 3), 'abc…(截断)');
  assert.equal(truncate('', 5), '', '空串原样返回');
  assert.equal(truncate(null, 5), '', 'null 安全');
  assert.equal(truncate(undefined, 5), '', 'undefined 安全');
});

test('评论列表纯文本（MCP comment_list 用）：带 id 方便 AI 改删', () => {
  const t = ticket();
  const out = renderCommentList(t, t.comments);
  assert.ok(out.startsWith('# ai-mcp-ticket comments: demo-project#12  (2)'), '首行带 ref 与条数');
  assert.ok(out.includes('- [2026-11-04T03:10:00.000Z] ai:deepseek (deepseek-v4.1)'));
  assert.ok(out.includes('  id: c1'), '必须给评论 id，否则 AI 无法改/删评论');
  assert.ok(out.trimEnd().endsWith('# end.'));

  const empty = renderCommentList(t, []);
  assert.ok(empty.includes('(暂无评论)'));
});

test('图片链接必须补成绝对 URL（AI 拿到相对路径会当成文件系统目录去找）', () => {
  const base = 'http://localhost:47321';
  assert.equal(absolutizeUploads('![](/uploads/a.png)', base), '![](http://localhost:47321/uploads/a.png)');
  assert.equal(
    absolutizeUploads('![](</uploads/b.png>)', base + '/'),
    '![](<http://localhost:47321/uploads/b.png>)',
    'baseUrl 末尾多余斜杠不能变成双斜杠',
  );
  assert.equal(
    absolutizeUploads('![](http://other:1/uploads/a.png)', base),
    '![](http://other:1/uploads/a.png)',
    '已经带主机的不能再补一遍',
  );
  assert.equal(absolutizeUploads('![](/uploads/a.png)', ''), '![](/uploads/a.png)', '没有 baseUrl 时保持原样');
});

test('列表 / 单张 / 评论列表三处渲染都要补绝对 URL', () => {
  const base = 'http://localhost:47321';
  const img = '![](/uploads/20261105-44bfeae7.png)';
  const withImg = ticket({
    content: `带图工单\n${img}`,
    comments: [{ ...ticket().comments[0], body: `评论里的图\n${img}` }],
  });

  const list = renderTicketList({ workspace: WS, tickets: [withImg], baseUrl: base });
  assert.ok(list.includes(`${base}/uploads/20261105-44bfeae7.png`), '列表视图（含评论）必须补绝对 URL');
  assert.ok(!list.includes('](/uploads/'), '列表里不能再留站内相对路径');

  const one = renderTicket(withImg, { workspace: WS, baseUrl: base });
  assert.ok(one.includes(`${base}/uploads/20261105-44bfeae7.png`), '单张工单（内容 + 评论）必须补绝对 URL');
  assert.ok(!one.includes('](/uploads/'), '单张工单里不能再留站内相对路径');

  const cs = renderCommentList(withImg, withImg.comments, { baseUrl: base });
  assert.ok(cs.includes(`${base}/uploads/20261105-44bfeae7.png`), 'comment_list 必须补绝对 URL');
});
