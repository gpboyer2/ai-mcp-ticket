// 评论 CRUD（契约 1.4、3.3）。
// 核心断言：评论写入后工单 updated_at 必须变化 —— AI 只靠这一个字段判断"有没有新动静"，
// 它不变等于告诉 AI「没新消息」，AI 就会漏读人类刚说的话。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, startTestApp, AI_HEADERS } from './_helpers.js';

const WS = 'demo-project';
const create = (base, payload) =>
  req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: payload }).then((r) => r.body);
const addComment = (base, ticketId, body, headers = {}) =>
  req(base, `/api/tickets/${ticketId}/comments`, { method: 'POST', body: { body }, headers });

test('评论增删改：正文、身份、model 都正确落库', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '有评论的工单' });

    // 用户评论
    const c1 = await addComment(app.base, t.id, '用户说的话');
    assert.equal(c1.status, 201, '新增评论应返回 201');
    assert.equal(c1.body.body, '用户说的话');
    assert.equal(c1.body.actor_id, 'user');
    assert.equal(c1.body.actor_role, 'user');
    assert.equal(c1.body.model, null, 'user 的 model 必须是 null（契约 1.4）');
    assert.equal(c1.body.ticket_id, t.id);
    assert.match(c1.body.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(c1.body.created_at, c1.body.updated_at, '刚创建时两个时间应相同');

    // AI 评论：必须记录当时的 model（契约 1.1：换模型后历史评论保留当时的 model）
    const c2 = await addComment(app.base, t.id, 'AI 说的话', AI_HEADERS);
    assert.equal(c2.body.actor_id, 'deepseek');
    assert.equal(c2.body.actor_role, 'ai');
    assert.equal(c2.body.model, 'deepseek-v4.1', 'AI 评论必须落 model');

    // 列评论：升序（契约 1.4）
    const list = await req(app.base, `/api/tickets/${t.id}/comments`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((c) => c.body), ['用户说的话', 'AI 说的话'], '评论按 created_at 升序');

    // 改正文：只有 body 和 updated_at 变
    const upd = await req(app.base, `/api/comments/${c1.body.id}`, {
      method: 'PATCH',
      body: { body: '用户改过的话' },
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.body, '用户改过的话');
    assert.equal(upd.body.created_at, c1.body.created_at, 'created_at 是审计事实，不能改');
    assert.equal(upd.body.actor_id, 'user', '评论的作者不能因编辑而变');
    assert.notEqual(upd.body.updated_at, c1.body.updated_at, '编辑评论后 updated_at 必须变');

    // 删评论
    const del = await req(app.base, `/api/comments/${c2.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    const after = await req(app.base, `/api/tickets/${t.id}/comments`);
    assert.deepEqual(after.body.map((c) => c.body), ['用户改过的话'], '删掉的评论不应再出现');
  } finally {
    await app.close();
  }
});

test('评论写入后工单 updated_at 必须变化（AI 判断新动静的唯一依据）', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '监听 updated_at' });

    // 新增评论
    await addComment(app.base, t.id, '新评论');
    const afterAdd = (await req(app.base, `/api/tickets/${t.id}`)).body;
    assert.ok(
      afterAdd.updated_at > t.updated_at,
      `新增评论后 updated_at 必须前进：before=${t.updated_at} after=${afterAdd.updated_at}`,
    );

    // 编辑评论
    const c = afterAdd.comments[0];
    await req(app.base, `/api/comments/${c.id}`, { method: 'PATCH', body: { body: '改一下' } });
    const afterEdit = (await req(app.base, `/api/tickets/${t.id}`)).body;
    assert.ok(
      afterEdit.updated_at > afterAdd.updated_at,
      `编辑评论后 updated_at 必须前进：before=${afterAdd.updated_at} after=${afterEdit.updated_at}`,
    );

    // 删除评论
    await req(app.base, `/api/comments/${c.id}`, { method: 'DELETE' });
    const afterDel = (await req(app.base, `/api/tickets/${t.id}`)).body;
    assert.ok(
      afterDel.updated_at > afterEdit.updated_at,
      `删除评论后 updated_at 必须前进：before=${afterEdit.updated_at} after=${afterDel.updated_at}`,
    );
  } finally {
    await app.close();
  }
});

test('连续快速写评论时 updated_at 每次都要前进（不能因同毫秒时间戳相同而看起来没动静）', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '快速连写' });
    const seen = [];
    // 连着写 5 条：网络往返已够快，同一毫秒内多次写入完全可能发生
    for (let i = 0; i < 5; i++) {
      await addComment(app.base, t.id, `第 ${i} 条`);
      seen.push((await req(app.base, `/api/tickets/${t.id}`)).body.updated_at);
    }
    for (let i = 1; i < seen.length; i++) {
      assert.ok(
        seen[i] > seen[i - 1],
        `第 ${i} 次写评论后 updated_at 必须严格大于上一次：${seen[i - 1]} → ${seen[i]}`,
      );
    }
  } finally {
    await app.close();
  }
});

test('评论校验：空 body / 纯空白 / 超长 10000 / 不存在工单', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '校验用' });

    const empty = await addComment(app.base, t.id, '');
    assert.equal(empty.status, 400, '空 body 评论必须 400');
    assert.ok(empty.body.error.code, '错误必须带 code（契约 3）');

    const blank = await addComment(app.base, t.id, '   \n\t  ');
    assert.equal(blank.status, 400, '纯空白也算空（否则会写出看不见的评论）');

    const long = await addComment(app.base, t.id, 'x'.repeat(10001));
    assert.equal(long.status, 400, '超过 10000 字必须 400（契约 1.4）');

    // 边界：正好 10000 字必须能写进去（否则上限写错了）
    const exactly = await addComment(app.base, t.id, 'x'.repeat(10000));
    assert.equal(exactly.status, 201, '正好 10000 字必须被接受');

    const noTicket = await addComment(app.base, 'no-such-ticket-id', '孤儿评论');
    assert.equal(noTicket.status, 404, '给不存在的工单写评论必须 404');

    // PATCH 空 body 也要拒绝
    const c = exactly.body;
    const patchEmpty = await req(app.base, `/api/comments/${c.id}`, { method: 'PATCH', body: { body: '  ' } });
    assert.equal(patchEmpty.status, 400, '把评论改成空白必须 400');
  } finally {
    await app.close();
  }
});

test('评论按 created_at 升序，同毫秒按 rowid 保序', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '排序' });
    const bodies = ['一', '二', '三', '四', '五'];
    for (const b of bodies) await addComment(app.base, t.id, b);
    const list = (await req(app.base, `/api/tickets/${t.id}/comments`)).body;
    assert.deepEqual(list.map((c) => c.body), bodies, '插入顺序必须被保留（契约 1.4 同毫秒按 rowid）');
    // created_at 必须单调不减
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].created_at >= list[i - 1].created_at, 'created_at 必须单调不减');
    }
  } finally {
    await app.close();
  }
});
