// 工单 CRUD（契约 1.3、3.2）。
// 断言重点：默认值、ref 形态、seq 连续性（不回收）、级联删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, startTestApp, AI_HEADERS } from './_helpers.js';

const WS = 'demo-project';

/** 建一张工单，返回 body */
async function createTicket(base, payload, headers = {}) {
  return req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: payload, headers });
}

test('新建：默认 status=open / priority=1，且审计字段齐全', async () => {
  const app = await startTestApp();
  try {
    const r = await createTicket(app.base, { title: '最小工单' });
    assert.equal(r.status, 201, '新建成功必须返回 201（契约 3.2）');
    const t = r.body;
    // 契约 1.3 的默认值
    assert.equal(t.status, 'open', 'status 默认必须是 open');
    assert.equal(t.priority, 1, 'priority 默认必须是 1（普通）');
    assert.equal(t.body, '', 'body 可空，缺省应是空串而不是 null');
    assert.equal(t.blocked_by, '', 'blocked_by 缺省应是空串');
    assert.equal(t.seq, 1, '第一个工单 seq 必须是 1');
    assert.equal(t.ref, `${WS}#1`, 'ref 必须是 {slug}#{seq}');
    // 审计三字段（契约 1.1：创建后不可改）
    assert.equal(t.actor_id, 'user', '不带身份头时默认是用户本人');
    assert.equal(t.actor_role, 'user');
    assert.equal(t.model, null, 'user 的 model 必须是 null');
    // 时间必须是 ISO8601 UTC
    assert.match(t.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'created_at 必须是 ISO8601 UTC');
    assert.match(t.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(t.created_at, t.updated_at, '刚创建时 created_at 应等于 updated_at');
    assert.ok(t.id && t.id.length === 36, 'id 必须是 uuid v4');
    assert.equal(t.workspace_id, 'ws-demo');
    assert.equal(t.workspace_slug, WS);
    assert.ok(t.position > 0, 'position 是数值且为正');

    // AI 身份建单要记录 model
    const ai = await createTicket(app.base, { title: 'AI 建的' }, AI_HEADERS);
    assert.equal(ai.body.actor_role, 'ai');
    assert.equal(ai.body.actor_id, 'deepseek');
    assert.equal(ai.body.model, 'deepseek-v4.1', 'AI 的 model 必须落库（契约 1.1 审计事实）');
  } finally {
    await app.close();
  }
});

test('读：单条含 comments 数组；列表返回 workspace/tickets/counts 三段', async () => {
  const app = await startTestApp();
  try {
    const t = (await createTicket(app.base, { title: '带评论的', body: '正文内容' })).body;
    await req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body: { body: '第一条' } });

    const one = await req(app.base, `/api/tickets/${t.id}`);
    assert.equal(one.status, 200);
    assert.ok(Array.isArray(one.body.comments), '契约 3.2 要求单条返回含 comments 数组');
    assert.equal(one.body.comments.length, 1);
    assert.equal(one.body.comments[0].body, '第一条');
    assert.equal(one.body.body, '正文内容');

    // 用 ref 读（MCP / AI 常用 ref 而不是 uuid）
    const byRef = await req(app.base, `/api/tickets/${encodeURIComponent(t.ref)}`);
    assert.equal(byRef.status, 200, '契约 3.2 的 :id 也接受 ref 形式');
    assert.equal(byRef.body.id, t.id, 'ref 与 uuid 必须指向同一张工单');

    const list = await req(app.base, `/api/workspaces/${WS}/tickets`);
    assert.equal(list.status, 200);
    assert.ok(list.body.workspace, '列表必须带 workspace');
    assert.equal(list.body.workspace.slug, WS);
    assert.ok(Array.isArray(list.body.tickets));
    assert.equal(list.body.tickets.length, 1);
    assert.ok(list.body.counts, '列表必须带 counts（契约 3.2）');
    assert.equal(list.body.counts.open, 1);
    assert.equal(list.body.counts.total, 1);
  } finally {
    await app.close();
  }
});

test('改：PATCH 局部更新，未传的字段不动，updated_at 必须变', async () => {
  const app = await startTestApp();
  try {
    const t = (await createTicket(app.base, { title: '原标题', body: '原正文', priority: 2 })).body;
    // 只改标题
    const p = await req(app.base, `/api/tickets/${t.id}`, { method: 'PATCH', body: { title: '新标题' } });
    assert.equal(p.status, 200);
    assert.equal(p.body.title, '新标题');
    assert.equal(p.body.body, '原正文', 'PATCH 是局部更新，没传的 body 不能被动');
    assert.equal(p.body.priority, 2, '没传 priority 不能被重置成默认值');
    assert.equal(p.body.status, 'open', '没传 status 不能变');
    assert.equal(p.body.created_at, t.created_at, 'created_at 是审计事实，永远不变');
    assert.notEqual(p.body.updated_at, t.updated_at, '更新后 updated_at 必须变化（AI 靠它判断动静）');

    // 改 body / priority / blocked_by（契约 1.3：blocked_by 必须是真实存在的工单）
    const dep = (await createTicket(app.base, { title: '被依赖的工单' })).body;
    const p2 = await req(app.base, `/api/tickets/${t.id}`, {
      method: 'PATCH',
      body: { body: '新正文', priority: 3, blocked_by: dep.ref },
    });
    assert.equal(p2.body.body, '新正文');
    assert.equal(p2.body.priority, 3);
    assert.equal(p2.body.blocked_by, dep.ref);
    assert.equal(p2.body.title, '新标题', '第二次 PATCH 不能把标题退回原值');

    // 不存在的 ref 必须 400 BLOCKED_BY_INVALID
    const badDep = await req(app.base, `/api/tickets/${t.id}`, {
      method: 'PATCH',
      body: { blocked_by: `${WS}#9999` },
    });
    assert.equal(badDep.status, 400);
    assert.equal(badDep.body.error.code, 'BLOCKED_BY_INVALID');

    // 清空依赖是合法的
    const cleared = await req(app.base, `/api/tickets/${t.id}`, { method: 'PATCH', body: { blocked_by: '' } });
    assert.equal(cleared.body.blocked_by, '');
  } finally {
    await app.close();
  }
});

test('删：级联删评论，删后再取 404，seq 不回收', async () => {
  const app = await startTestApp();
  try {
    const t1 = (await createTicket(app.base, { title: '第一个' })).body;
    await req(app.base, `/api/tickets/${t1.id}/comments`, { method: 'POST', body: { body: '会被一起删' } });

    const del = await req(app.base, `/api/tickets/${t1.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true, '契约 3.2 要求返回 {deleted:true}');

    assert.equal((await req(app.base, `/api/tickets/${t1.id}`)).status, 404, '删后取单条应 404');
    assert.equal(
      (await req(app.base, `/api/tickets/${t1.id}/comments`)).status,
      404,
      '评论必须随工单级联消失（否则留下孤儿评论）',
    );

    // 契约 1.3：seq 不回收
    const t2 = (await createTicket(app.base, { title: '删后再建' })).body;
    assert.equal(t2.seq, 2, '删除后 seq 不得回收，新工单必须拿 #2');
    assert.equal(t2.ref, `${WS}#2`);
  } finally {
    await app.close();
  }
});

test('seq 在同一工作区内连续递增，不同工作区各自独立', async () => {
  const app = await startTestApp({
    workspaces: {
      'ws-demo': { path: '/tmp/demo-project', title: 'demo' },
      'ws-other': { path: '/tmp/other-project', title: 'other' },
    },
  });
  try {
    const seqs = [];
    for (let i = 1; i <= 4; i++) {
      const r = await createTicket(app.base, { title: `工单 ${i}` });
      seqs.push(r.body.seq);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4], '同一工作区内 seq 必须从 1 开始连续递增');

    // 另一个工作区从头开始，且 ref 前缀是它自己的 slug
    const other = await req(app.base, '/api/workspaces/other-project/tickets', {
      method: 'POST',
      body: { title: '别的工作区的第一张' },
    });
    assert.equal(other.body.seq, 1, '不同工作区的 seq 各自从 1 开始');
    assert.equal(other.body.ref, 'other-project#1', 'ref 的 slug 部分必须是它自己工作区的 slug');

    // ref 唯一性：demo-project#1 与 other-project#1 是两张不同工单
    const a = await req(app.base, `/api/tickets/${encodeURIComponent('demo-project#1')}`);
    const b = await req(app.base, `/api/tickets/${encodeURIComponent('other-project#1')}`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.id, b.body.id, '不同工作区同 seq 必须是不同工单');
  } finally {
    await app.close();
  }
});

test('列表查询参数：status 过滤 / q 搜索 / sort / limit', async () => {
  const app = await startTestApp();
  try {
    const a = (await createTicket(app.base, { title: '修复登录闪退', body: '复现：点登录就崩' })).body;
    const b = (await createTicket(app.base, { title: '加个深色模式', body: '参考 system 偏好' })).body;
    // 契约 5.5.1：open 不能直接到 done，必须 in_progress → done
    await req(app.base, `/api/tickets/${b.id}`, { method: 'PATCH', body: { status: 'in_progress' } });
    await req(app.base, `/api/tickets/${b.id}`, { method: 'PATCH', body: { status: 'done' } });

    // status 过滤（契约 3.2：可重复 / 逗号分隔）
    const openOnly = (await req(app.base, `/api/workspaces/${WS}/tickets?status=open`)).body;
    assert.deepEqual(openOnly.tickets.map((t) => t.id), [a.id], 'status=open 只返回 open 的工单');
    const multi = (await req(app.base, `/api/workspaces/${WS}/tickets?status=open,done`)).body;
    assert.equal(multi.tickets.length, 2, '逗号分隔的多状态过滤应都命中');

    // q 在 title + body 里模糊匹配
    const byTitle = (await req(app.base, `/api/workspaces/${WS}/tickets?q=${encodeURIComponent('闪退')}`)).body;
    assert.deepEqual(byTitle.tickets.map((t) => t.id), [a.id], 'q 应能匹配标题');
    const byBody = (await req(app.base, `/api/workspaces/${WS}/tickets?q=${encodeURIComponent('system')}`)).body;
    assert.deepEqual(byBody.tickets.map((t) => t.id), [b.id], 'q 必须也搜正文（契约 3.2）');

    // limit
    const limited = (await req(app.base, `/api/workspaces/${WS}/tickets?limit=1`)).body;
    assert.equal(limited.tickets.length, 1, 'limit 应生效');
    // counts 不受 status 过滤影响（前端列头要显示每列总数）
    assert.equal(limited.counts.open, 1);
    assert.equal(limited.counts.done, 1);
  } finally {
    await app.close();
  }
});
