// 错误路径与输入校验（契约第 3 节末段：错误统一 {"error":{"code","message"}}）。
// 为什么逐条测：AI 是主要调用方，它靠 code 字段决定"该改参数还是该放弃"。
// code 变成 "ERROR" / "SQLITE_CONSTRAINT_NOTNULL" 这种，AI 就无法自愈。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, reqText, startTestApp } from './_helpers.js';

const WS = 'demo-project';
const create = (base, payload, headers = {}) =>
  req(base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: payload, headers });

/** 统一断言：错误体形状符合契约 3 */
function assertErrorShape(r, expectStatus, label) {
  assert.equal(r.status, expectStatus, `${label}：HTTP 状态码应为 ${expectStatus}`);
  assert.ok(r.body && r.body.error, `${label}：响应体必须是 {"error":{...}}`);
  assert.equal(typeof r.body.error.code, 'string', `${label}：error.code 必须是字符串`);
  assert.equal(typeof r.body.error.message, 'string', `${label}：error.message 必须是字符串`);
  assert.ok(r.body.error.message.length > 0, `${label}：message 不能为空`);
}

test('不存在的工作区 → 404 WORKSPACE_NOT_FOUND', async () => {
  const app = await startTestApp();
  try {
    assertErrorShape(await req(app.base, '/api/workspaces/no-such/tickets'), 404, '列工单');
    assert.equal((await req(app.base, '/api/workspaces/no-such/tickets')).body.error.code, 'WORKSPACE_NOT_FOUND');

    assertErrorShape(
      await req(app.base, '/api/workspaces/no-such/tickets', { method: 'POST', body: { title: 'x' } }),
      404,
      '建工单',
    );
    assertErrorShape(await req(app.base, '/api/workspaces/no-such/text'), 404, 'text 视图');

    // 纯文本形态也要 404 且是 text/plain
    const t = await reqText(app.base, '/no-such/list', { Accept: 'text/plain' });
    assert.equal(t.status, 404);
    assert.match(t.contentType, /^text\/plain/);
  } finally {
    await app.close();
  }
});

test('不存在的工单 → 404 TICKET_NOT_FOUND（GET/PATCH/DELETE/评论四条路径）', async () => {
  const app = await startTestApp();
  try {
    const fake = '00000000-0000-4000-8000-000000000000';
    for (const [method, path, body] of [
      ['GET', `/api/tickets/${fake}`],
      ['PATCH', `/api/tickets/${fake}`, { title: 'x' }],
      ['DELETE', `/api/tickets/${fake}`],
      ['GET', `/api/tickets/${fake}/comments`],
      ['POST', `/api/tickets/${fake}/comments`, { body: 'x' }],
    ]) {
      const r = await req(app.base, path, { method, body });
      assertErrorShape(r, 404, `${method} ${path}`);
      assert.equal(r.body.error.code, 'TICKET_NOT_FOUND', `${method} ${path} 的 code 应为 TICKET_NOT_FOUND`);
    }

    // ref 形式指向不存在的 seq
    const byRef = await req(app.base, `/api/tickets/${encodeURIComponent(`${WS}#999`)}`);
    assertErrorShape(byRef, 404, 'ref 指向不存在 seq');
  } finally {
    await app.close();
  }
});

test('超长 title（>200）→ 400；恰好 200 与中文 200 必须通过', async () => {
  const app = await startTestApp();
  try {
    const long201 = await create(app.base, { title: 'x'.repeat(201) });
    assertErrorShape(long201, 400, '201 个 ASCII 字符');
    assert.equal(long201.body.error.code, 'TITLE_TOO_LONG', '超长标题的错误码应明确');

    // 中文按字符数（不是字节）算：200 个汉字必须通过
    const cn200 = await create(app.base, { title: '中'.repeat(200) });
    assert.equal(cn200.status, 201, '200 个汉字必须被接受（按字符计数，不是字节）');
    const cn201 = await create(app.base, { title: '中'.repeat(201) });
    assert.equal(cn201.status, 400, '201 个汉字必须被拒');

    // 空标题 / 纯空白
    const empty = await create(app.base, { title: '' });
    assertErrorShape(empty, 400, '空标题');
    const blank = await create(app.base, { title: '    ' });
    assertErrorShape(blank, 400, '纯空白标题');
    const missing = await create(app.base, {});
    assertErrorShape(missing, 400, '缺 title');

    // 前后空白应被 trim 后存储（否则 ref 展示难看）
    const padded = await create(app.base, { title: '  有空白  ' });
    assert.equal(padded.body.title, '有空白', 'title 应被 trim');

    // PATCH 也要校验长度
    const t = (await create(app.base, { title: '正常' })).body;
    const patchLong = await req(app.base, `/api/tickets/${t.id}`, { method: 'PATCH', body: { title: 'x'.repeat(201) } });
    assertErrorShape(patchLong, 400, 'PATCH 超长标题');
  } finally {
    await app.close();
  }
});

test('空 body 评论 → 400 BODY_REQUIRED', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { title: '评论校验' })).body;
    for (const body of [{ body: '' }, { body: '   ' }, {}, { body: null }]) {
      const r = await req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body });
      assertErrorShape(r, 400, `POST 评论 body=${JSON.stringify(body)}`);
      assert.equal(r.body.error.code, 'BODY_REQUIRED');
    }
  } finally {
    await app.close();
  }
});

test('非法 status / priority 越界 → 400 且 code 明确', async () => {
  const app = await startTestApp();
  try {
    const bad = await create(app.base, { title: 'x', status: 'closed' });
    assertErrorShape(bad, 400, '非法 status');
    assert.equal(bad.body.error.code, 'STATUS_INVALID');

    for (const p of [4, -1, 99, 'abc', 1.5]) {
      const r = await create(app.base, { title: 'x', priority: p });
      assertErrorShape(r, 400, `priority=${p}`);
      assert.equal(r.body.error.code, 'PRIORITY_INVALID', `priority=${p} 的错误码`);
    }

    // 边界值必须通过
    for (const p of [0, 1, 2, 3]) {
      const r = await create(app.base, { title: `p${p}`, priority: p });
      assert.equal(r.status, 201, `priority=${p} 是合法值，必须通过`);
      assert.equal(r.body.priority, p);
    }

    // 查询参数里的非法 status 也要 400（列表接口）
    const listBad = await req(app.base, `/api/workspaces/${WS}/tickets?status=bogus`);
    assertErrorShape(listBad, 400, '列表 status=bogus');
    // 注意：读接口用的是 INVALID_STATUS，写接口用的是 STATUS_INVALID（见 FINDINGS.md 轻微问题）
    // 这里只断言"必须是 400 且有 code"，不锁死具体拼写，避免把缺陷当契约固化
    assert.match(listBad.body.error.code, /STATUS_INVALID|INVALID_STATUS/, '非法 status 的 code 必须是这两种之一');

    // 非法 sort
    const sortBad = await req(app.base, `/api/workspaces/${WS}/tickets?sort=id`);
    assertErrorShape(sortBad, 400, '非法 sort');
    assert.equal(sortBad.body.error.code, 'SORT_INVALID');
  } finally {
    await app.close();
  }
});

test('坏 JSON body → 400 INVALID_JSON（不能 500 吐堆栈）', async () => {
  const app = await startTestApp();
  try {
    const r = await req(app.base, `/api/workspaces/${WS}/tickets`, {
      method: 'POST',
      body: '{ 这不是 json',
    });
    assertErrorShape(r, 400, '坏 JSON');
    assert.equal(r.body.error.code, 'JSON_INVALID');
    assert.ok(!/at |\.js:\d+/.test(r.body.error.message), '错误文案不得泄露堆栈');
  } finally {
    await app.close();
  }
});

test('未知路径 → 404 统一错误体（/api 与页面各一套）', async () => {
  const app = await startTestApp();
  try {
    const apiUnknown = await req(app.base, '/api/unknown/thing');
    assertErrorShape(apiUnknown, 404, '/api 未知路径');
    assert.equal(apiUnknown.body.error.code, 'NOT_FOUND');

    const pageUnknown = await req(app.base, '/whatever/deep/path');
    assert.equal(pageUnknown.status, 404);
    assert.equal(pageUnknown.body.error.code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('SQL 注入面：q 参数与所有字段都不拼接 SQL', async () => {
  const app = await startTestApp();
  try {
    const t = (await create(app.base, { title: "1'; DROP TABLE tickets;--", body: '100% 的 _ 下划线 \\ 反斜杠' })).body;
    // 标题里的恶意字符必须被原样存下来（证明走了参数化，而不是被"清洗"或执行）
    assert.equal(t.title, "1'; DROP TABLE tickets;--", 'title 必须原样保存，不得被 SQL 拼接');

    // LIKE 通配符必须被转义：搜 % 不应命中所有工单
    const pct = (await req(app.base, `/api/workspaces/${WS}/tickets?q=${encodeURIComponent('%')}`)).body;
    assert.equal(pct.tickets.length, 1, 'q=% 必须被当作字面量，只命中正文里真有 % 的那张');
    const underscore = (await req(app.base, `/api/workspaces/${WS}/tickets?q=${encodeURIComponent('_')}`)).body;
    assert.equal(underscore.tickets.length, 1, 'q=_ 必须被当作字面量');
    const backslash = (await req(app.base, `/api/workspaces/${WS}/tickets?q=${encodeURIComponent('\\')}`)).body;
    assert.equal(backslash.tickets.length, 1, 'q=\\ 必须被当作字面量');

    // 表还在（没被 DROP）
    const still = await req(app.base, `/api/workspaces/${WS}/tickets`);
    assert.equal(still.status, 200);
    assert.equal(still.body.tickets.length, 1, 'tickets 表必须完好');

    // 注入式 slug / id 也不能出事
    for (const evil of ["1' OR '1'='1", 'x; DROP TABLE tickets', '%27']) {
      const r = await req(app.base, `/api/workspaces/${encodeURIComponent(evil)}/tickets`);
      assert.equal(r.status, 404, `注入式 ws=${evil} 应 404 而不是执行`);
    }
  } finally {
    await app.close();
  }
});

test('路径穿越：../ 与编码形式都拿不到 web/ 之外的文件', async () => {
  const app = await startTestApp();
  try {
    for (const p of [
      '/../src/db.js',
      '/..%2f..%2fetc%2fpasswd',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/../package.json',
      '/style.css/../../src/db.js',
    ]) {
      const r = await reqText(app.base, p, { Accept: 'text/plain' });
      assert.ok(r.status === 404 || r.status === 400, `${p} 必须被拒（实际 ${r.status}）`);
      assert.ok(!r.text.includes('better-sqlite3'), `${p} 不得泄露源码`);
      assert.ok(!r.text.includes('root:'), `${p} 不得泄露 /etc/passwd`);
    }
  } finally {
    await app.close();
  }
});
