// position 语义（契约 3.2 末段）：同状态内新建 position 递增；改 status 落到目标列末尾；
// 显式传 position 时以传入为准（拖拽）。
// 为什么要单独测：拖拽排序是网页唯一的排序手段，position 一乱整块看板顺序就废了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, startTestApp } from './_helpers.js';

const WS = 'demo-project';
const create = (base, payload) =>
  req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: payload }).then((r) => r.body);
const patch = (base, id, payload) =>
  req(base, `/api/tickets/${id}`, { method: 'PATCH', body: payload }).then((r) => r.body);

test('同状态内新建工单的 position 递增（新单落在列末尾）', async () => {
  const app = await startTestApp();
  try {
    const a = await create(app.base, { content: 'A' });
    const b = await create(app.base, { content: 'B' });
    const c = await create(app.base, { content: 'C' });
    assert.ok(a.position < b.position, `新建必须排在后面：A=${a.position} B=${b.position}`);
    assert.ok(b.position < c.position, `新建必须排在后面：B=${b.position} C=${c.position}`);

    // 列表默认按 position 升序，所以顺序应与创建顺序一致
    const list = (await req(app.base, `/api/workspaces/${WS}/tickets`)).body.tickets;
    assert.deepEqual(list.map((t) => t.content), ['A', 'B', 'C'], '默认排序 position asc 应与创建顺序一致');

    // 不同状态各自独立算末尾：done 列是空的，第一张 done 的 position 应小于 open 列的第三张
    const d = await create(app.base, { content: 'D', status: 'done' });
    assert.equal(d.position, 1024, '空列的第一张工单 position 从 1024 起步');
    const d2 = await create(app.base, { content: 'E', status: 'done' });
    assert.equal(d2.position, 2048, '同列第二张 = 前一张 + 1024');
    assert.equal(c.position, 3072, 'open 列第三张仍是 3072（done 列的新增不影响 open 列）');
  } finally {
    await app.close();
  }
});

test('PATCH 改 status：position 自动落到目标列末尾', async () => {
  const app = await startTestApp();
  try {
    const a = await create(app.base, { content: 'A' });
    const b = await create(app.base, { content: 'B' });
    // 目标列（in_progress）先放两张
    const x = await create(app.base, { content: 'X', status: 'in_progress' });
    const y = await create(app.base, { content: 'Y', status: 'in_progress' });
    assert.equal(x.position, 1024);
    assert.equal(y.position, 2048);

    // 把 A 从 open 挪到 in_progress，没传 position → 应落到 2048+1024
    const movedA = await patch(app.base, a.id, { status: 'in_progress' });
    assert.equal(movedA.status, 'in_progress');
    assert.equal(
      movedA.position,
      y.position + 1024,
      `换列后应落到目标列末尾（${y.position}+1024），实际 ${movedA.position}`,
    );

    // 目标列顺序：X, Y, A
    const ip = (await req(app.base, `/api/workspaces/${WS}/tickets?status=in_progress`)).body.tickets;
    assert.deepEqual(ip.map((t) => t.content), ['X', 'Y', 'A'], '换列的工单应排在目标列最后');

    // open 列现在只剩 B，且 B 的 position 不受影响
    const open = (await req(app.base, `/api/workspaces/${WS}/tickets?status=open`)).body.tickets;
    assert.deepEqual(open.map((t) => t.content), ['B']);
    assert.equal(open[0].position, b.position, '别的列换列不应改动本列的 position');

    // 再挪回来：落到 open 列末尾（B 之后）
    const back = await patch(app.base, a.id, { status: 'open' });
    assert.equal(back.position, b.position + 1024, '挪回 open 列应落在 B 之后');
  } finally {
    await app.close();
  }
});

test('显式传 position（拖拽）时以传入值为准，即使同时改了 status', async () => {
  const app = await startTestApp();
  try {
    const a = await create(app.base, { content: 'A' });
    await create(app.base, { content: 'B', status: 'done' });
    await create(app.base, { content: 'C', status: 'done' });

    // 拖到 done 列最前面：同时传 status + position
    // 契约 5.5.1：open 不能直达 done，先推进到 in_progress
    await patch(app.base, a.id, { status: 'in_progress' });
    const dragged = await patch(app.base, a.id, { status: 'done', position: 10 });
    assert.equal(dragged.status, 'done');
    assert.equal(dragged.position, 10, '显式 position 必须优先于"落到列末尾"');
    const done = (await req(app.base, `/api/workspaces/${WS}/tickets?status=done`)).body.tickets;
    assert.deepEqual(done.map((t) => t.content), ['A', 'B', 'C'], 'position=10 应排到最前');

    // 同列内拖拽排序：只传 position，不改 status
    const c = done.find((t) => t.content === 'C');
    const moved = await patch(app.base, c.id, { position: 5 });
    assert.equal(moved.position, 5);
    assert.equal(moved.status, 'done', '只改 position 不应影响 status');
    const done2 = (await req(app.base, `/api/workspaces/${WS}/tickets?status=done`)).body.tickets;
    assert.deepEqual(done2.map((t) => t.content), ['C', 'A', 'B'], 'position=5 应排到最前');

    // 浮点 position（拖拽时取前后中间值）必须支持
    const mid = await patch(app.base, c.id, { position: 7.5 });
    assert.equal(mid.position, 7.5, 'position 是 float（契约 1.3），中间值必须原样保存');
    const done3 = (await req(app.base, `/api/workspaces/${WS}/tickets?status=done`)).body.tickets;
    assert.deepEqual(done3.map((t) => t.content), ['C', 'A', 'B'], '7.5 仍应在 A(10) 之前');
  } finally {
    await app.close();
  }
});

test('新建时显式传 position 也以传入值为准', async () => {
  const app = await startTestApp();
  try {
    await create(app.base, { content: 'A' }); // position 1024
    const top = await create(app.base, { content: '插到最前', position: 1 });
    assert.equal(top.position, 1, '新建时显式 position 必须被尊重');
    const list = (await req(app.base, `/api/workspaces/${WS}/tickets`)).body.tickets;
    assert.deepEqual(list.map((t) => t.content), ['插到最前', 'A'], 'position=1 的新单应排在最前');
  } finally {
    await app.close();
  }
});

test('status 未变时 PATCH 不改 position（否则同列编辑会打乱顺序）', async () => {
  const app = await startTestApp();
  try {
    const a = await create(app.base, { content: 'A' });
    const b = await create(app.base, { content: 'B' });
    // 显式把 status 写成与当前相同的值
    const same = await patch(app.base, a.id, { status: 'open', content: 'A 改名' });
    assert.equal(same.position, a.position, 'status 没变化时不能把 position 重排到末尾');
    assert.equal(same.content, 'A 改名');

    const list = (await req(app.base, `/api/workspaces/${WS}/tickets`)).body.tickets;
    assert.deepEqual(list.map((t) => t.content), ['A 改名', 'B'], '顺序必须保持不变');
    assert.ok(b.position > a.position);
  } finally {
    await app.close();
  }
});
