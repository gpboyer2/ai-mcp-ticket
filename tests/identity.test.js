// 身份规则（契约第 2 节）。
// 为什么死盯这条：role=ai 却不带 model，等于让 AI 匿名发言，事后无法审计"哪个模型说的"，
// 而本项目全部价值都建立在这份审计事实之上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, startTestApp, AI_HEADERS } from './_helpers.js';

const WS = 'demo-project';
const create = (base, payload, headers = {}) =>
  req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: payload, headers }).then((r) => r.body);
const comment = (base, ticketId, headers = {}, body = 'x') =>
  req(base, `/api/tickets/${ticketId}/comments`, { method: 'POST', body: { body }, headers });

test('role=ai 缺 id 或 model → 400 且 code=ACTOR_REQUIRED', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '身份校验' });

    // 缺 model
    const noModel = await comment(app.base, t.id, { 'X-Actor-Role': 'ai', 'X-Actor-Id': 'dsh-lead' });
    assert.equal(noModel.status, 400, 'ai 缺 model 必须 400');
    assert.equal(noModel.body.error.code, 'ACTOR_REQUIRED', '错误码必须是 ACTOR_REQUIRED（契约 2）');
    assert.match(noModel.body.error.message, /model|id/i, 'message 应说清缺什么，方便 AI 自己修');

    // 缺 id
    const noId = await comment(app.base, t.id, { 'X-Actor-Role': 'ai', 'X-Actor-Model': 'group/cherish-ai' });
    assert.equal(noId.status, 400);
    assert.equal(noId.body.error.code, 'ACTOR_REQUIRED');

    // 两个都缺
    const neither = await comment(app.base, t.id, { 'X-Actor-Role': 'ai' });
    assert.equal(neither.status, 400);
    assert.equal(neither.body.error.code, 'ACTOR_REQUIRED');

    // 空串也算缺（不能把 '' 当成合法身份写进库）
    const emptyStr = await comment(app.base, t.id, {
      'X-Actor-Role': 'ai',
      'X-Actor-Id': '',
      'X-Actor-Model': '  ',
    });
    assert.equal(emptyStr.status, 400, '空白 id/model 必须视同缺失');
    assert.equal(emptyStr.body.error.code, 'ACTOR_REQUIRED');

    // 建单路径同样要校验（不能只校验评论）
    const createNoModel = await req(app.base, `/api/workspaces/${WS}/tickets`, {
      method: 'POST',
      body: { title: 'AI 建单' },
      headers: { 'X-Actor-Role': 'ai', 'X-Actor-Id': 'dsh-lead' },
    });
    assert.equal(createNoModel.status, 400, '建工单也必须校验 actor');
    assert.equal(createNoModel.body.error.code, 'ACTOR_REQUIRED');

    // 失败时不能留下脏数据
    const list = (await req(app.base, `/api/workspaces/${WS}/tickets`)).body.tickets;
    assert.equal(list.length, 1, '身份校验失败不能建出工单');
    const comments = (await req(app.base, `/api/tickets/${t.id}/comments`)).body;
    assert.equal(comments.length, 0, '身份校验失败不能写出评论');
  } finally {
    await app.close();
  }
});

test('role=user 时强制 id=user、model=null（忽略传入值）', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '用户归一' });

    // 头里带了假的 id/model，但 role=user → 必须被归一
    const viaHeader = await comment(app.base, t.id, {
      'X-Actor-Role': 'user',
      'X-Actor-Id': 'hacker',
      'X-Actor-Model': 'fake-model',
    });
    assert.equal(viaHeader.status, 201);
    assert.equal(viaHeader.body.actor_id, 'user', 'role=user 时 id 必须强制成 user');
    assert.equal(viaHeader.body.model, null, 'role=user 时 model 必须强制成 null');

    // body.actor 里也带假的
    const viaBody = await req(app.base, `/api/tickets/${t.id}/comments`, {
      method: 'POST',
      body: { body: 'x', actor: { id: 'someone', role: 'user', model: 'm1' } },
    });
    assert.equal(viaBody.body.actor_id, 'user');
    assert.equal(viaBody.body.model, null);

    // query 里也带假的
    const viaQuery = await req(
      app.base,
      `/api/tickets/${t.id}/comments?actor_id=qp&actor_role=user&actor_model=qm`,
      { method: 'POST', body: { body: 'x' } },
    );
    assert.equal(viaQuery.body.actor_id, 'user');
    assert.equal(viaQuery.body.model, null);

    // 完全不带身份 → 默认就是 user
    const none = await comment(app.base, t.id, {});
    assert.equal(none.body.actor_id, 'user', '不带任何身份时默认 role=user（契约 2）');
    assert.equal(none.body.actor_role, 'user');
    assert.equal(none.body.model, null);
  } finally {
    await app.close();
  }
});

test('三个来源的优先级：头 > body.actor > query', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '优先级' });
    const query = '?actor_id=q-actor&actor_role=ai&actor_model=q-model';

    // 三者都给：头赢
    const all3 = await req(app.base, `/api/tickets/${t.id}/comments${query}`, {
      method: 'POST',
      body: { body: 'x', actor: { id: 'b-actor', role: 'ai', model: 'b-model' } },
      headers: AI_HEADERS,
    });
    assert.equal(all3.body.actor_id, 'dsh-lead', '头优先级最高（契约 2）');
    assert.equal(all3.body.model, 'group/cherish-ai');

    // 只给 body + query：body 赢
    const bodyAndQuery = await req(app.base, `/api/tickets/${t.id}/comments${query}`, {
      method: 'POST',
      body: { body: 'x', actor: { id: 'b-actor', role: 'ai', model: 'b-model' } },
    });
    assert.equal(bodyAndQuery.body.actor_id, 'b-actor', 'body.actor 优先于 query');
    assert.equal(bodyAndQuery.body.model, 'b-model');

    // 只给 query
    const queryOnly = await req(app.base, `/api/tickets/${t.id}/comments${query}`, {
      method: 'POST',
      body: { body: 'x' },
    });
    assert.equal(queryOnly.body.actor_id, 'q-actor', '没有头和 body.actor 时才用 query');
    assert.equal(queryOnly.body.model, 'q-model');
    assert.equal(queryOnly.body.actor_role, 'ai');
  } finally {
    await app.close();
  }
});

test('非法 role 被拒，且不会静默降级成 user', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '非法 role' });
    for (const bad of ['robot', 'AI', 'Ai', 'admin', '1']) {
      const r = await comment(app.base, t.id, { 'X-Actor-Role': bad, 'X-Actor-Id': 'x', 'X-Actor-Model': 'm' });
      assert.equal(r.status, 400, `role=${bad} 必须 400，不能悄悄当 user 处理`);
      assert.equal(r.body.error.code, 'ACTOR_ROLE_INVALID', `role=${bad} 的错误码应为 ACTOR_ROLE_INVALID`);
    }
  } finally {
    await app.close();
  }
});

test('首次出现的 actor 自动登记到 actors 表，并统计写入次数', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '登记' });
    await comment(app.base, t.id, AI_HEADERS);
    await comment(app.base, t.id, AI_HEADERS);
    await comment(app.base, t.id, {}); // user

    const actors = (await req(app.base, '/api/actors')).body;
    const ai = actors.find((a) => a.id === 'dsh-lead' && a.role === 'ai');
    assert.ok(ai, 'AI 首次写入必须自动登记（契约 2）');
    assert.equal(ai.model, 'group/cherish-ai');
    assert.equal(ai.comment_count, 2, 'comment_count 应统计该身份写过的评论数（契约 3.4）');
    assert.equal(ai.ticket_count, 0);
    assert.ok(ai.first_seen_at && ai.last_seen_at, 'first_seen_at / last_seen_at 必须都有值');
    assert.ok(ai.last_seen_at >= ai.first_seen_at);

    const user = actors.find((a) => a.id === 'user' && a.role === 'user');
    assert.ok(user, '用户身份也要登记');
    assert.equal(user.model, null);
    assert.equal(user.ticket_count, 1, 'user 建了 1 张工单');
    assert.equal(user.comment_count, 1);

    // 显式登记 AI 身份（POST /api/actors）必须幂等，不能产生重复行
    const reg1 = await req(app.base, '/api/actors', {
      method: 'POST',
      body: { id: 'claude-code', role: 'ai', model: 'claude-sonnet-4.5' },
    });
    assert.equal(reg1.status, 201);
    const reg2 = await req(app.base, '/api/actors', {
      method: 'POST',
      body: { id: 'claude-code', role: 'ai', model: 'claude-sonnet-4.5' },
    });
    assert.equal(reg2.status, 201);
    const after = (await req(app.base, '/api/actors')).body;
    assert.equal(
      after.filter((a) => a.id === 'claude-code').length,
      1,
      '重复登记同一身份只能有一行（actors 有唯一索引）',
    );

    // 显式登记 AI 缺 model 也要 400
    const badReg = await req(app.base, '/api/actors', { method: 'POST', body: { id: 'x', role: 'ai' } });
    assert.equal(badReg.status, 400);
    assert.equal(badReg.body.error.code, 'ACTOR_REQUIRED');
  } finally {
    await app.close();
  }
});

test('同一个 AI 换模型后，历史评论保留当时的 model（契约 1.1）', async () => {
  const app = await startTestApp();
  try {
    const t = await create(app.base, { title: '换模型' });
    const oldComment = await comment(app.base, t.id, {
      'X-Actor-Role': 'ai',
      'X-Actor-Id': 'dsh-lead',
      'X-Actor-Model': 'group/cherish-ai',
    });
    const newComment = await comment(app.base, t.id, {
      'X-Actor-Role': 'ai',
      'X-Actor-Id': 'dsh-lead',
      'X-Actor-Model': 'claude-sonnet-4.5',
    });
    assert.equal(oldComment.body.model, 'group/cherish-ai', '历史评论的 model 不得被改写');
    assert.equal(newComment.body.model, 'claude-sonnet-4.5', '新评论记新模型');

    // actors 表里应出现两行（同 id 不同 model）
    const actors = (await req(app.base, '/api/actors')).body.filter((a) => a.id === 'dsh-lead');
    assert.equal(actors.length, 2, '同 id 不同 model 应各占一行，便于看出"哪个模型在干活"');
    assert.deepEqual(actors.map((a) => a.model).sort(), ['claude-sonnet-4.5', 'group/cherish-ai']);
  } finally {
    await app.close();
  }
});
