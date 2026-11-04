// 契约 5.5：状态迁移表（硬约束）与状态提醒（软约束）。
// 为什么单独一个文件：这两条是"行为约束"而不是数据读写，混在 tickets.test.js 里会看不出它们是同一套设计。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, req, reqText, AI_HEADERS } from './_helpers.js';
import { allowedTransitions } from '../src/repo/tickets.js';
import { statusHint } from '../src/render/text.js';

const WS = 'demo-project';

async function create(base, body = {}) {
  return req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: { title: 'T', ...body } });
}
const patch = async (base, id, body) => req(base, `/api/tickets/${id}`, { method: 'PATCH', body });

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
      const t = (await create(app.base, { title: `${from}->${to}` })).body;
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
    const t = (await create(app.base, { title: 'open 不能直达 done' })).body;
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
    const t = (await create(app.base, { title: '幂等' })).body;
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
    const t = (await create(app.base, { title: '救援路径' })).body;
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
    const t = (await create(app.base, { title: 'done 也能删' })).body;
    await patch(app.base, t.id, { status: 'in_progress' });
    await patch(app.base, t.id, { status: 'done' });
    const del = await req(app.base, `/api/tickets/${t.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
  } finally {
    await app.close();
  }
});

test('状态提醒：AI 给 open 工单加评论，末尾追加提醒行', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { title: '提醒测试' })).body;
    const c = await req(app.base, `/api/tickets/${t.id}/comments`, {
      method: 'POST',
      headers: AI_HEADERS,
      body: { body: '我看了一下这个问题' },
    });
    assert.equal(c.status, 201);
  } finally {
    await app.close();
  }
});

test('statusHint：三条触发规则与不触发的情况', () => {
  // 规则 1：open + comment_add + AI
  assert.match(
    statusHint({ status: 'open', event: 'comment_add', actorRole: 'ai' }),
    /该工单仍是「打开」。若你已开始处理，请调 ticket_update status=in_progress/,
  );
  // 规则 2：in_progress + 完工词
  for (const word of ['已完成', '搞定了', '已修复', '已解决', '修好了', 'done', 'fixed', 'resolved']) {
    assert.match(
      statusHint({ status: 'in_progress', event: 'comment_add', body: `这个问题${word}`, actorRole: 'ai' }),
      /评论像是完工报告/,
      `完工词「${word}」应触发提醒`,
    );
  }
  // 规则 3：open + ticket_create + AI
  assert.match(
    statusHint({ status: 'open', event: 'ticket_create', actorRole: 'ai' }),
    /新建的工单是「打开」/,
  );

  // 不该提醒的情况
  assert.equal(statusHint({ status: 'open' }), null, '读操作（无 event）不加提醒');
  assert.equal(statusHint({ status: 'done', event: 'comment_add', body: '已完成' }), null, 'done 状态不提醒');
  assert.equal(statusHint({ status: 'in_progress', event: 'comment_add', body: '还在看' }), null, '没完工词不提醒');
  assert.equal(statusHint({ status: 'open', event: 'ticket_create', actorRole: 'user' }), null, '用户建单不提醒');
});

test('状态提醒：读接口不追加提醒行', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { title: '读操作无提醒' })).body;
    await req(app.base, `/api/tickets/${t.id}/comments`, {
      method: 'POST',
      headers: AI_HEADERS,
      body: { body: '开始看了' },
    });

    const one = await reqText(app.base, `/${WS}/t/${t.seq}.txt`);
    assert.ok(!one.text.includes('# 状态提醒'), `单张读接口不该有提醒：\n${one.text}`);
    const list = await reqText(app.base, `/${WS}/list?format=text`);
    assert.ok(!list.text.includes('# 状态提醒'), `列表读接口不该有提醒：\n${list.text}`);
  } finally {
    await app.close();
  }
});

test('状态提醒：MCP comment_add 返回文本末尾带提醒', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { title: 'MCP 提醒' })).body;
    const mcp = async (payload) => {
      const res = await fetch(app.base + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(payload),
      });
      return res.json();
    };
    const r = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'comment_add',
        arguments: { ref: t.ref, body: '我处理一下', actor_id: 'dsh-lead', actor_model: 'group/cherish-ai' },
      },
    });
    const text = r.result.content[0].text;
    assert.match(text, /# 状态提醒: 该工单仍是「打开」/);
    // 提醒必须在 # end. 之前
    assert.ok(
      text.indexOf('# 状态提醒') < text.indexOf('# end.'),
      '提醒行应放在 # end. 之前',
    );
  } finally {
    await app.close();
  }
});

test('M1：工单 body 上限 100000 字，超了 400 BODY_TOO_LONG', async () => {
  const app = await startTestApp();
  try {
    const okBody = '字'.repeat(100000);
    const ok = await create(app.base, { title: '刚好到上限', body: okBody });
    assert.equal(ok.status, 201, '100000 字应放行');

    const tooLong = '字'.repeat(100001);
    const bad = await create(app.base, { title: '超一个字', body: tooLong });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BODY_TOO_LONG');

    // PATCH 路径同样受限
    const t = (await create(app.base, { title: 'PATCH 超限' })).body;
    const p = await patch(app.base, t.id, { body: tooLong });
    assert.equal(p.status, 400);
    assert.equal(p.body.error.code, 'BODY_TOO_LONG');
  } finally {
    await app.close();
  }
});

test('M2：blocked_by 必须是真实存在的 ref，create 与 update 都校验', async () => {
  const app = await startTestApp();
  try {
    const dep = (await create(app.base, { title: '依赖目标' })).body;

    // create：合法 ref 放行
    const good = await create(app.base, { title: '有依赖', blocked_by: dep.ref });
    assert.equal(good.status, 201);
    assert.equal(good.body.blocked_by, dep.ref);

    // create：格式非法
    const badFormat = await create(app.base, { title: 'x', blocked_by: '乱写' });
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body.error.code, 'BLOCKED_BY_INVALID');

    // create：格式对但工单不存在
    const missing = await create(app.base, { title: 'x', blocked_by: `${WS}#9999` });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'BLOCKED_BY_INVALID');
    assert.match(missing.body.error.message, /9999/, '文案要指出哪个 ref 不合法');

    // 多个 ref 里有一个坏的就整体拒绝，且文案点名坏的
    const mixed = await create(app.base, { title: 'x', blocked_by: `${dep.ref},nope#1` });
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
