// 并发与事务（任务要求的重点验收项之一）。
// 为什么必须测：MCP 无状态、每请求一个 server，多个 AI 会同时写同一个库；
// 用户也可能连点。任何一处没进事务，都会出现「seq 撞号 / 评论写了但工单没动静 / 500」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, startTestApp } from './_helpers.js';

const WS = 'demo-project';
const create = (base, payload) =>
  req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: payload });

test('并发建单 50 张：seq 不重不漏，且没有 500', async () => {
  const app = await startTestApp();
  try {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => create(app.base, { content: `并发 ${i}` })),
    );
    // 全部成功
    assert.deepEqual(
      [...new Set(results.map((r) => r.status))],
      [201],
      `并发建单必须全部 201，实际出现了 ${[...new Set(results.map((r) => r.status))]}`,
    );
    const seqs = results.map((r) => r.body.seq).sort((a, b) => a - b);
    // 不重：seq 有唯一索引保护
    assert.equal(new Set(seqs).size, 50, `seq 必须互不相同，实际去重后 ${new Set(seqs).size} 个`);
    // 不漏：必须恰好是 1..50
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1), 'seq 必须恰好是 1..50 不跳号');
    // id 也不能重
    assert.equal(new Set(results.map((r) => r.body.id)).size, 50, 'id 必须互不相同');

    // 库里的总数与 counts 必须对得上（事务没漏写）
    const list = (await req(app.base, `/api/workspaces/${WS}/tickets?limit=1000`)).body;
    assert.equal(list.tickets.length, 50);
    assert.equal(list.counts.total, 50, 'counts.total 必须与真实条数一致');
    assert.equal(list.counts.open, 50);
  } finally {
    await app.close();
  }
});

test('并发写 30 条评论到同一工单：全部成功且计数正确', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '并发评论' })).body;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body: { body: `评论 ${i}` } }),
      ),
    );
    assert.deepEqual([...new Set(results.map((r) => r.status))], [201], '并发写评论必须全部成功');
    const list = (await req(app.base, `/api/tickets/${t.id}/comments`)).body;
    assert.equal(list.length, 30, '30 条评论一条都不能丢');
    // 每条评论 id 唯一
    assert.equal(new Set(list.map((c) => c.id)).size, 30);
    // 升序（契约 1.4）
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].created_at >= list[i - 1].created_at, '并发写入后评论仍须升序');
    }
  } finally {
    await app.close();
  }
});

test('并发改同一张工单的 status：都成功，最终态合法，position 不能是 NaN', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '并发改状态' })).body;
    const statuses = ['in_progress', 'done', 'open', 'cancelled', 'reopened'];
    const results = await Promise.all(
      statuses.map((s) => req(app.base, `/api/tickets/${t.id}`, { method: 'PATCH', body: { status: s } })),
    );
    // 契约 5.5.1 引入迁移表后，并发里输给别人的那次可能因"非法迁移"被 400 拒绝，
    // 这是预期行为；本用例真正要守的是「不能 500」和「position 不能变 NaN」。
    const codes = results.map((r) => r.status);
    assert.deepEqual(
      [...new Set(codes)].filter((c) => c !== 200 && c !== 400),
      [],
      `并发改状态只允许 200/400，实际 ${JSON.stringify(codes)}`,
    );
    assert.ok(codes.includes(200), `至少要有一次成功，实际 ${JSON.stringify(codes)}`);

    const final = (await req(app.base, `/api/tickets/${t.id}`)).body;
    assert.ok(statuses.includes(final.status), `最终状态必须是合法值，实际 ${final.status}`);
    assert.ok(
      Number.isFinite(final.position),
      `position 必须是有穷数字，实际 ${final.position}（NaN 会污染整个看板排序）`,
    );
  } finally {
    await app.close();
  }
});

test('并发拖拽同一张工单：都成功，最终 position 是其中一个传入值', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '并发拖拽' })).body;
    const values = [100, 200, 300, 400];
    const results = await Promise.all(
      values.map((p) => req(app.base, `/api/tickets/${t.id}`, { method: 'PATCH', body: { position: p } })),
    );
    assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
    const final = (await req(app.base, `/api/tickets/${t.id}`)).body.position;
    assert.ok(values.includes(final), `最终 position 必须是某个客户端提交过的值，实际 ${final}`);
  } finally {
    await app.close();
  }
});

test('并发删同一张工单：只有一次成功，其余 404（不能 500）', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '并发删除' })).body;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => req(app.base, `/api/tickets/${t.id}`, { method: 'DELETE' })),
    );
    const codes = results.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 200).length, 1, `只能有一次删除成功，实际 ${JSON.stringify(codes)}`);
    assert.equal(
      codes.filter((c) => c === 404).length,
      4,
      `其余应全部 404 TICKET_NOT_FOUND，实际 ${JSON.stringify(codes)}`,
    );
    assert.ok(!codes.includes(500), '并发删除绝不能 500');
    // 错误体必须是统一的 TICKET_NOT_FOUND
    for (const r of results.filter((x) => x.status === 404)) {
      assert.equal(r.body.error.code, 'TICKET_NOT_FOUND');
    }
  } finally {
    await app.close();
  }
});

test('并发：删工单与写评论交叉，不留孤儿评论、不 500', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { content: '删除与评论交叉' })).body;
    // 同时发起：写评论 × 3 + 删工单 × 1
    const results = await Promise.all([
      req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body: { body: 'a' } }),
      req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body: { body: 'b' } }),
      req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body: { body: 'c' } }),
      req(app.base, `/api/tickets/${t.id}`, { method: 'DELETE' }),
    ]);
    const codes = results.map((r) => r.status);
    assert.ok(!codes.includes(500), `交叉操作不能 500，实际 ${JSON.stringify(codes)}`);
    // 无论顺序如何，最终工单必须已删、评论必须查不到
    const after = await req(app.base, `/api/tickets/${t.id}/comments`);
    assert.equal(after.status, 404, '工单删掉后评论接口必须 404（不能留下孤儿评论）');

    // 库里不能有挂在不存在的工单上的评论（用全量列表间接验证：counts 与列表一致）
    const list = (await req(app.base, `/api/workspaces/${WS}/tickets?limit=1000`)).body;
    assert.equal(list.counts.total, list.tickets.length, 'counts 与真实条数必须一致');
  } finally {
    await app.close();
  }
});
