// 契约 5.5：状态迁移表（硬约束）、状态硬门（AI 不能在「打开」的单上写评论）、
// 评论与状态原子提交、读侧漏网标记。
// 为什么单独一个文件：这些是"行为约束"而不是数据读写，混在 tickets.test.js 里会看不出它们是同一套设计。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, req, reqText, mcpCall, AI_HEADERS } from './_helpers.js';
import { allowedTransitions } from '../src/repo/tickets.js';
import { claimLockHint, renderTicketList } from '../src/render/text.js';

const WS = 'demo-project';

async function create(base, body = {}) {
  return req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: { content: 'T', ...body } });
}
const patch = async (base, id, body) => req(base, `/api/tickets/${id}`, { method: 'PATCH', body });
const comment = async (base, id, body, { headers = {}, status } = {}) =>
  req(base, `/api/tickets/${id}/comments`, { method: 'POST', headers, body: { body, status } });

// ---------- 5.5.1 迁移表 ----------

test('迁移表：契约 5.5.1 的每一条合法迁移都放行', async () => {
  const app = await startTestApp();
  try {
    // 逐条走一遍表里列出的合法迁移（同状态幂等也在表里）
    const paths = [
      ['open', 'in_progress'],
      ['open', 'cancelled'],
      ['in_progress', 'done'],
      ['in_progress', 'reopened'],
      ['in_progress', 'cancelled'],
      ['in_progress', 'open'],
      ['reopened', 'in_progress'],
      ['reopened', 'cancelled'],
      ['done', 'reopened'],
      ['cancelled', 'reopened'],
    ];
    for (const [from, to] of paths) {
      // 每条路径都用一张新工单，避免相互影响
      const t = (await create(app.base, { content: `${from}->${to}` })).body;
      if (from !== 'open') {
        // 先把工单推到起点：open → in_progress → 目标起点
        await patch(app.base, t.id, { status: 'in_progress' });
        if (from !== 'in_progress') await patch(app.base, t.id, { status: from });
      }
      const r = await patch(app.base, t.id, { status: to });
      assert.equal(r.status, 200, `${from} → ${to} 应该放行，实际 ${r.status} ${r.text}`);
      assert.equal(r.body.status, to);
    }
  } finally {
    await app.close();
  }
});

test('迁移表：非法迁移返回 400 TRANSITION_INVALID 且文案带可选值', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: 'open 不能直达 done' })).body;
    const r = await patch(app.base, t.id, { status: 'done' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'TRANSITION_INVALID');
    // 文案必须告诉 AI「从 X 只能去 A/B/C」，它才能一次改对
    assert.match(r.body.error.message, /open/);
    for (const s of allowedTransitions('open')) {
      assert.ok(r.body.error.message.includes(s), `文案应列出可选值 ${s}：${r.body.error.message}`);
    }

    // done 不能跳回 open（只能 reopened 中转）
    await patch(app.base, t.id, { status: 'in_progress' });
    await patch(app.base, t.id, { status: 'done' });
    const back = await patch(app.base, t.id, { status: 'open' });
    assert.equal(back.status, 400);
    assert.equal(back.body.error.code, 'TRANSITION_INVALID');
  } finally {
    await app.close();
  }
});

test('迁移表：同状态幂等必须放行（前端拖回原位不能报错）', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '幂等' })).body;
    const r = await patch(app.base, t.id, { status: 'open' });
    assert.equal(r.status, 200, '同状态迁移必须放行');
    assert.equal(r.body.status, 'open');
  } finally {
    await app.close();
  }
});

test('迁移表：救援路径 done → reopened → in_progress 必须通', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '救援路径' })).body;
    await patch(app.base, t.id, { status: 'in_progress' });
    await patch(app.base, t.id, { status: 'done' });
    const reopened = await patch(app.base, t.id, { status: 'reopened' });
    assert.equal(reopened.status, 200);
    const working = await patch(app.base, t.id, { status: 'in_progress' });
    assert.equal(working.status, 200);
    assert.equal(working.body.status, 'in_progress');
  } finally {
    await app.close();
  }
});

test('迁移表：删除不受状态限制', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: 'done 也能删' })).body;
    await patch(app.base, t.id, { status: 'in_progress' });
    await patch(app.base, t.id, { status: 'done' });
    const del = await req(app.base, `/api/tickets/${t.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
  } finally {
    await app.close();
  }
});

// ---------- 5.5.2 硬门：AI 不能在「打开」的单上写评论 ----------

test('硬门：open 单上 AI 写评论 → 400 TICKET_NOT_STARTED，且评论没落库', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '硬门' })).body;
    const r = await comment(app.base, t.id, '我看了一下这个问题', { headers: AI_HEADERS });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'TICKET_NOT_STARTED');
    // 文案必须一次给出两条可行路径，AI 才能当场改对
    assert.match(r.body.error.message, /in_progress/, '文案要给出 in_progress 这条路');
    assert.match(r.body.error.message, /status/, '文案要说明怎么带 status');

    // 拒绝就是拒绝：不能写进去
    const after = (await req(app.base, `/api/tickets/${t.id}/comments`)).body;
    assert.equal(after.length, 0, '被硬门拒绝时评论不能落库');
    assert.equal((await req(app.base, `/api/tickets/${t.id}`)).body.status, 'open', '状态也不能被动过');
  } finally {
    await app.close();
  }
});

test('硬门：open 单上 AI 带 status=in_progress 写评论 → 201，状态与评论同时落库', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '原子提交' })).body;
    const r = await comment(app.base, t.id, '开始处理了', { headers: AI_HEADERS, status: 'in_progress' });
    assert.equal(r.status, 201, `带 status=in_progress 必须放行，实际 ${r.status} ${r.text}`);
    assert.equal(r.body.body, '开始处理了');

    const one = (await req(app.base, `/api/tickets/${t.id}`)).body;
    assert.equal(one.status, 'in_progress', '状态必须一起改掉');
    assert.equal(one.comments.length, 1, '评论必须落库');
  } finally {
    await app.close();
  }
});

test('硬门：open 单上 AI 带 status=open（同状态）仍拒绝——它没表态', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '原地不动' })).body;
    const r = await comment(app.base, t.id, 'x', { headers: AI_HEADERS, status: 'open' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'TICKET_NOT_STARTED');
  } finally {
    await app.close();
  }
});

test('硬门：user 在 open 单上写评论不受影响（网页上的操作一切照旧）', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '用户照旧' })).body;
    const r = await comment(app.base, t.id, '用户说的话');
    assert.equal(r.status, 201, `user 必须不受硬门影响，实际 ${r.status} ${r.text}`);
    assert.equal(r.body.actor_role, 'user');
    assert.equal((await req(app.base, `/api/tickets/${t.id}`)).body.status, 'open', 'user 写评论不改状态');
  } finally {
    await app.close();
  }
});

test('硬门：AI 在非 open 状态写评论一律放行（in_progress / reopened / done）', async () => {
  const app = await startTestApp();
  try {
    for (const status of ['in_progress', 'reopened', 'done']) {
      const t = (await create(app.base, { content: `起点 ${status}` })).body;
      await patch(app.base, t.id, { status: 'in_progress' });
      if (status !== 'in_progress') await patch(app.base, t.id, { status });
      const r = await comment(app.base, t.id, `${status} 上写评论`, { headers: AI_HEADERS });
      assert.equal(r.status, 201, `${status} 状态上 AI 写评论应放行，实际 ${r.status} ${r.text}`);
    }
  } finally {
    await app.close();
  }
});

test('硬门：MCP comment_add 在 open 单上同样被拒（REST 与 MCP 共用同一个守卫）', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: 'MCP 硬门' })).body;
    const rejected = await mcpCall(app.base, 'comment_add', {
      ref: t.ref,
      body: 'MCP 想直接评论',
      actor_id: 'deepseek',
      actor_model: 'deepseek-v4.1',
    });
    assert.equal(rejected.isError, true, 'MCP 也必须被拒，不能有第二条漏网的路');
    assert.match(rejected.content[0].text, /TICKET_NOT_STARTED|打开/);

    // 带 status=in_progress 就放行，并返回推进后的纯文本
    const ok = await mcpCall(app.base, 'comment_add', {
      ref: t.ref,
      body: 'MCP 带状态评论',
      status: 'in_progress',
      actor_id: 'deepseek',
      actor_model: 'deepseek-v4.1',
    });
    assert.notEqual(ok.isError, true, `带 status 应放行：${ok.content?.[0]?.text}`);
    assert.match(ok.content[0].text, /status: 处理中 \(in_progress\)/, '返回的纯文本必须已是新状态');
    assert.match(ok.content[0].text, /MCP 带状态评论/);
  } finally {
    await app.close();
  }
});

// ---------- 5.5.2 原子提交：状态照样过迁移表、done 释放认领 ----------

test('原子提交：in_progress 单上 AI 带 status=done 写评论 → 201，状态 done 且认领被释放', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '收尾' })).body;
    await patch(app.base, t.id, { status: 'in_progress' });
    const claimed = await req(app.base, `/api/tickets/${t.id}/claim`, { method: 'POST', headers: AI_HEADERS });
    assert.equal(claimed.status, 200, '先认领，才能验证 done 会释放认领');
    assert.equal(claimed.body.assignee_id, 'deepseek');

    const r = await comment(app.base, t.id, '做完了', { headers: AI_HEADERS, status: 'done' });
    assert.equal(r.status, 201, `带 status=done 必须放行，实际 ${r.status} ${r.text}`);

    const one = (await req(app.base, `/api/tickets/${t.id}`)).body;
    assert.equal(one.status, 'done', '状态必须一起改成 done');
    assert.equal(one.comments.length, 1);
    // 契约 3.2.1：改成 done/cancelled 时同一次 UPDATE 释放认领四列
    assert.equal(one.assignee_id, null, 'done 必须释放认领');
    assert.equal(one.assignee_role, null);
    assert.equal(one.assignee_model, null);
    assert.equal(one.claimed_at, null);
  } finally {
    await app.close();
  }
});

test('原子提交：状态迁移非法时整条回滚，评论也不落库', async () => {
  const app = await startTestApp();
  try {
    // open → done 是非法迁移（契约 5.5.1）
    const t = (await create(app.base, { content: '跳步' })).body;
    const r = await comment(app.base, t.id, '直接说做完了', { headers: AI_HEADERS, status: 'done' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'TRANSITION_INVALID', '状态迁移必须继续走迁移表，不许另造一套');

    const one = (await req(app.base, `/api/tickets/${t.id}`)).body;
    assert.equal(one.status, 'open', '迁移被拒时状态不能变');
    assert.equal(one.comments.length, 0, '迁移被拒时评论不能落库（原子性）');
  } finally {
    await app.close();
  }
});

test('原子提交：未知 status → 400 STATUS_INVALID，评论不落库', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '非法状态' })).body;
    const r = await comment(app.base, t.id, 'x', { headers: AI_HEADERS, status: 'closed' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'STATUS_INVALID');
    assert.equal((await req(app.base, `/api/tickets/${t.id}/comments`)).body.length, 0);
  } finally {
    await app.close();
  }
});

test('原子提交：user 也能带 status（前端不改行为，但契约允许）', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '用户改状态' })).body;
    const r = await comment(app.base, t.id, '用户说开始做了', { status: 'in_progress' });
    assert.equal(r.status, 201);
    assert.equal((await req(app.base, `/api/tickets/${t.id}`)).body.status, 'in_progress');
  } finally {
    await app.close();
  }
});

// ---------- 5.5.4 读侧漏网标记 ----------

/** 从列表纯文本里取出所有 `# 待办:` 行 */
const todoLines = (text) => text.split('\n').filter((l) => l.startsWith('# 待办: '));

test('读侧标记：处理中 + 最后一条 AI 评论像完工报告 → 提示补 status=done', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '漏收尾' })).body;
    await patch(app.base, t.id, { status: 'in_progress' });
    await comment(app.base, t.id, '已修复并自测通过', { headers: AI_HEADERS });

    const list = await reqText(app.base, `/${WS}/list.txt?status=in_progress`);
    const todos = todoLines(list.text);
    assert.equal(todos.length, 1, `应恰好一行待办：\n${list.text}`);
    assert.ok(todos[0].includes(t.ref), '标记里要点名是哪张单');
    assert.ok(todos[0].includes('status=done'), '标记要告诉 AI 该补 done');
    // 放在 # end. 之前
    assert.ok(
      list.text.indexOf('# 待办: ') < list.text.indexOf('# end. '),
      '待办标记必须在 # end. 之前',
    );

    // 只标记不改数据：状态仍然是处理中
    assert.equal((await req(app.base, `/api/tickets/${t.id}`)).body.status, 'in_progress');
  } finally {
    await app.close();
  }
});

test('读侧标记：open 单上有 AI 评论 → 提示补 status=in_progress（历史遗留那类）', async () => {
  const app = await startTestApp();
  try {
    // 造一张「AI 干过活、状态还是打开」的单：先 in_progress 写评论，再合法挪回 open
    // （契约 5.5.1 允许 in_progress → open）。这正是用户抱怨的那类漏网单。
    const t = (await create(app.base, { content: '干过活还开着' })).body;
    await patch(app.base, t.id, { status: 'in_progress' });
    await comment(app.base, t.id, '已修复并自测通过', { headers: AI_HEADERS });
    const back = await patch(app.base, t.id, { status: 'open' });
    assert.equal(back.status, 200, 'in_progress → open 是合法迁移');

    const list = await reqText(app.base, `/${WS}/list.txt?status=open`);
    const todos = todoLines(list.text);
    assert.equal(todos.length, 1, `open 单上 AI 评论过就该标：\n${list.text}`);
    assert.ok(todos[0].includes(t.ref), '要点名是哪张单');
    assert.ok(todos[0].includes('status=in_progress'), '提示应指向 in_progress，不是 done');
    assert.ok(!todos[0].includes('status=done'), 'open 档不能提示 done（会诱导跳步）');

    // 只标记不改数据
    assert.equal((await req(app.base, `/api/tickets/${t.id}`)).body.status, 'open');
  } finally {
    await app.close();
  }
});

test('读侧标记：reopened + 完工词 → 与 in_progress 同一档（补 done）', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '救回来的单' })).body;
    await patch(app.base, t.id, { status: 'in_progress' });
    await patch(app.base, t.id, { status: 'done' });
    await patch(app.base, t.id, { status: 'reopened' });
    await comment(app.base, t.id, '已修复', { headers: AI_HEADERS });

    const list = await reqText(app.base, `/${WS}/list.txt?status=reopened`);
    const todos = todoLines(list.text);
    assert.equal(todos.length, 1, `reopened + 完工词该标：\n${list.text}`);
    assert.ok(todos[0].includes(t.ref));
    assert.ok(todos[0].includes('status=done'), 'reopened 也归 done 档');
    // reopened 不能直达 done，文案必须给出中转那一步，否则 AI 照着调会吃 400
    assert.ok(todos[0].includes('in_progress'), 'reopened 档要说明先经 in_progress 中转');
  } finally {
    await app.close();
  }
});

test('读侧标记：open 单上只有用户评论 → 不标', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '用户自己写的' })).body;
    await comment(app.base, t.id, '已修复');

    const list = await reqText(app.base, `/${WS}/list.txt?status=open`);
    assert.ok(!list.text.includes('# 待办: '), `用户评论不该触发标记：\n${list.text}`);
  } finally {
    await app.close();
  }
});

test('读侧标记：最后一条 AI 评论没完工词 → 不标', async () => {
  const app = await startTestApp();
  try {
    // 早先说过完工、但最后一条 AI 评论是"还在补" → 不算漏收尾
    const a = (await create(app.base, { content: '又发现新问题' })).body;
    await patch(app.base, a.id, { status: 'in_progress' });
    await comment(app.base, a.id, '已修复', { headers: AI_HEADERS });
    await comment(app.base, a.id, '又发现一个边界问题，还在改', { headers: AI_HEADERS });

    // 最后一条 AI 评论没有完工词
    const b = (await create(app.base, { content: '还在看' })).body;
    await patch(app.base, b.id, { status: 'in_progress' });
    await comment(app.base, b.id, '还在定位', { headers: AI_HEADERS });

    const list = await reqText(app.base, `/${WS}/list.txt?comments=0`);
    assert.ok(!list.text.includes('# 待办: '), `不该出现待办标记：\n${list.text}`);
  } finally {
    await app.close();
  }
});

test('读侧标记：评论里在讨论状态值本身（done → reopened / status=done / position: fixed）→ 不标', async () => {
  const app = await startTestApp();
  try {
    // 裸英文 done / fixed 在本项目里几乎总是在讨论状态值或 CSS 属性，不是完工声明。
    // 拿真实库 41 条 AI 评论量过：带裸英文词命中 14 条，其中 6 条是这种元文本（误报 43%）。
    // 所以词表只认中文完工词，且必须出现在句首/行首或作为完工标题。
    const metas = [
      '状态五图标：open=circle、in_progress=circle-dashed、done=circle-check、cancelled=circle-x',
      '合法迁移：in_progress → done | reopened | cancelled | open；done → reopened',
      '干完了就在写评论时带 status=done —— 这是推进到已完成的唯一方式',
      '详情面板改为 position: fixed 贴右浮层，脱离 flex 流',
      '这一轮把 missedStatusKind 改成按状态分两档，没有动其它逻辑',
      '收到，这条我来做。方案：把依赖字段换成可搜索的下拉选择器',
    ];
    for (const body of metas) {
      const t = (await create(app.base, { content: `元文本 ${body.slice(0, 10)}` })).body;
      await patch(app.base, t.id, { status: 'in_progress' });
      await comment(app.base, t.id, body, { headers: AI_HEADERS });
    }

    const list = await reqText(app.base, `/${WS}/list.txt?comments=0`);
    assert.ok(
      !list.text.includes('# 待办: '),
      `讨论状态值本身不是完工声明，不能标（乱报的提醒会和旧 statusHint 一样被无视）：\n${list.text}`,
    );
  } finally {
    await app.close();
  }
});

test('读侧标记：完工声明出现在句首或作为标题 → 要标', async () => {
  const app = await startTestApp();
  try {
    const reports = [
      '已完成。新增 tests/file-size-limit.test.js（只此一个新文件）',
      '已修复并验收通过。根因：详情页 content 区原先只渲染 t.body',
      '## 做完的动作\n\n**一、截图不再进仓库**',
      '## 完成情况\n\n硬门 + 原子提交 + 读侧标记三条都落地了',
    ];
    for (const body of reports) {
      const t = (await create(app.base, { content: `完工报告 ${body.slice(0, 10)}` })).body;
      await patch(app.base, t.id, { status: 'in_progress' });
      await comment(app.base, t.id, body, { headers: AI_HEADERS });
    }

    const list = await reqText(app.base, `/${WS}/list.txt?comments=0`);
    const todos = todoLines(list.text);
    assert.equal(todos.length, 1, `四条完工报告都该被点名（同一档合并成一行）：\n${list.text}`);
    assert.ok(todos[0].includes('status=done'));
  } finally {
    await app.close();
  }
});

test('读侧标记：done / cancelled 单不标（哪怕评论像完工报告）', async () => {
  const app = await startTestApp();
  try {
    for (const status of ['done', 'cancelled']) {
      const t = (await create(app.base, { content: `已是 ${status}` })).body;
      await patch(app.base, t.id, { status: 'in_progress' });
      if (status === 'cancelled') {
        await patch(app.base, t.id, { status: 'cancelled' });
      } else {
        await comment(app.base, t.id, '已修复', { headers: AI_HEADERS });
        await patch(app.base, t.id, { status: 'done' });
      }
      // 状态到位后再补一条 AI 评论（done/cancelled 上写评论是允许的）
      await comment(app.base, t.id, '已完成', { headers: AI_HEADERS });
    }
    const list = await reqText(app.base, `/${WS}/list.txt?comments=0`);
    assert.ok(!list.text.includes('# 待办: '), `done/cancelled 不该标：\n${list.text}`);
  } finally {
    await app.close();
  }
});

test('读侧标记：三种原因都不存在时不输出该行', async () => {
  const app = await startTestApp();
  try {
    // 一张干干净净的 open 单（没评论）、一张正常处理中（AI 说还在看）
    await create(app.base, { content: '还没人动过' });
    const b = (await create(app.base, { content: '正常在干' })).body;
    await patch(app.base, b.id, { status: 'in_progress' });
    await comment(app.base, b.id, '还在定位', { headers: AI_HEADERS });

    const list = await reqText(app.base, `/${WS}/list.txt`);
    assert.ok(!list.text.includes('# 待办: '), `没有漏网单时不能输出待办行：\n${list.text}`);
  } finally {
    await app.close();
  }
});

test('读侧标记：两类混在一起时分两行，各自点名该补什么状态', () => {
  const ticket = (ref, status, lastBody, actorRole = 'ai') => ({
    ref,
    status,
    content: 'c',
    actor_id: 'deepseek',
    actor_role: 'ai',
    model: 'm',
    priority: 1,
    created_at: '2026-11-04T03:00:00.000Z',
    updated_at: '2026-11-04T03:20:00.000Z',
    comments: [{ body: lastBody, actor_id: 'deepseek', actor_role: actorRole, model: 'm', created_at: '2026-11-04T03:10:00.000Z' }],
  });
  const out = renderTicketList({
    workspace: { slug: 'demo-project', path: '/tmp/demo' },
    tickets: [
      ticket('demo-project#1', 'in_progress', '已修复'),      // done 档
      ticket('demo-project#2', 'open', '开始看了'),           // in_progress 档
      ticket('demo-project#3', 'in_progress', '还在看'),      // 不标
      ticket('demo-project#4', 'done', '已完成'),             // 不标
      ticket('demo-project#5', 'open', '用户说的话', 'user'), // 不标（只有用户评论）
    ],
    statuses: null,
  });
  const todos = todoLines(out);
  assert.equal(todos.length, 2, `应分成两行：\n${out}`);

  const doneLine = todos.find((l) => l.includes('status=done'));
  const progLine = todos.find((l) => l.includes('status=in_progress'));
  assert.ok(doneLine && progLine, 'done 档与 in_progress 档各一行');
  assert.ok(doneLine.includes('demo-project#1') && !doneLine.includes('demo-project#2'), 'done 行只点 done 档');
  assert.ok(progLine.includes('demo-project#2') && !progLine.includes('demo-project#1'), 'in_progress 行只点 in_progress 档');
  // 只在待办行里找：out 本身含工单列表，每张单的 ref 都在，不能拿整段判断
  const todoText = todos.join('\n');
  for (const ref of ['demo-project#3', 'demo-project#4', 'demo-project#5']) {
    assert.ok(!todoText.includes(ref), `${ref} 不该被点名：${todoText}`);
  }

  // 都放在 # end. 之前
  assert.ok(out.indexOf('# 待办: ') < out.indexOf('# end. '), '待办行在 # end. 之前');
});

// ---------- 锁定提醒 ----------

test('claimLockHint：他人认领才提醒，自己和用户都不提醒', () => {
  const claimed = {
    assignee_id: 'other-ai',
    assignee_role: 'ai',
    assignee_model: 'm1',
    claimed_at: '2026-11-04T09:00:00.000Z',
  };
  const hint = claimLockHint(claimed, { id: 'me', role: 'ai' });
  assert.match(hint, /# 锁定提醒: 该工单已被 ai:other-ai \(m1\) 于 2026-11-04T09:00:00\.000Z 认领/);

  assert.equal(claimLockHint({ assignee_id: null }, { id: 'me', role: 'ai' }), null);
  assert.equal(claimLockHint(claimed, { id: 'other-ai', role: 'ai' }), null);
  assert.equal(claimLockHint(claimed, { id: 'user', role: 'user' }), null);
});

test('锁定提醒：被他人认领时，读视图里给出 assignee 行', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '锁定提醒测试' })).body;
    const claim = await req(app.base, `/api/tickets/${t.id}/claim`, {
      method: 'POST',
      headers: { 'X-Actor-Id': 'other-ai', 'X-Actor-Role': 'ai', 'X-Actor-Model': 'm1' },
    });
    assert.equal(claim.status, 200);

    const one = await reqText(app.base, `/${WS}/t/${t.seq}.txt`);
    assert.match(one.text, /assignee: ai:other-ai \(m1\) since /, '读视图必须给出 assignee 行');
  } finally {
    await app.close();
  }
});

// ---------- 既有内容校验用例（沿用） ----------

test('M1：工单 content 上限 100000 字，超了 400 CONTENT_TOO_LONG', async () => {
  const app = await startTestApp();
  try {
    const okContent = '字'.repeat(100000);
    const ok = await create(app.base, { content: okContent });
    assert.equal(ok.status, 201, '100000 字应放行');

    const tooLong = '字'.repeat(100001);
    const bad = await create(app.base, { content: tooLong });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'CONTENT_TOO_LONG');

    // PATCH 路径同样受限
    const t = (await create(app.base, { content: 'PATCH 超限' })).body;
    const p = await patch(app.base, t.id, { content: tooLong });
    assert.equal(p.status, 400);
    assert.equal(p.body.error.code, 'CONTENT_TOO_LONG');
  } finally {
    await app.close();
  }
});

test('M2：blocked_by 必须是真实存在的 ref，create 与 update 都校验', async () => {
  const app = await startTestApp();
  try {
    const dep = (await create(app.base, { content: '依赖目标' })).body;

    // create：合法 ref 放行
    const good = await create(app.base, { content: '有依赖', blocked_by: dep.ref });
    assert.equal(good.status, 201);
    assert.equal(good.body.blocked_by, dep.ref);

    // create：格式非法
    const badFormat = await create(app.base, { content: 'x', blocked_by: '乱写' });
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body.error.code, 'BLOCKED_BY_INVALID');

    // create：格式对但工单不存在
    const missing = await create(app.base, { content: 'x', blocked_by: `${WS}#9999` });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'BLOCKED_BY_INVALID');
    assert.match(missing.body.error.message, /9999/, '文案要指出哪个 ref 不合法');

    // 多个 ref 里有一个坏的就整体拒绝，且文案点名坏的
    const mixed = await create(app.base, { content: 'x', blocked_by: `${dep.ref},nope#1` });
    assert.equal(mixed.status, 400);
    assert.match(mixed.body.error.message, /nope#1/);

    // update：清空合法
    const cleared = await patch(app.base, good.body.id, { blocked_by: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.blocked_by, '');
  } finally {
    await app.close();
  }
});
