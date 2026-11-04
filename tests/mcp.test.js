// MCP 端点（契约第 5 节）。
// 核心断言：恰好 10 个工具、返回纯文本而不是 JSON、写工具缺身份要 isError。
// "不返回 JSON" 是本项目的核心取舍 —— 返回 JSON 就等于把 token 浪费在括号和引号上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, startTestApp, mcp, mcpInit, mcpCall } from './_helpers.js';

const WS = 'demo-project';

/** 契约第 5 节列的 10 个工具名（顺序无关，集合必须完全一致） */
const EXPECTED_TOOLS = [
  'workspace_list',
  'ticket_list',
  'ticket_get',
  'ticket_create',
  'ticket_update',
  'ticket_delete',
  'comment_list',
  'comment_add',
  'comment_update',
  'comment_delete',
];

test('initialize → tools/list 恰好 10 个工具，名字与契约第 5 节完全一致', async () => {
  const app = await startTestApp();
  try {
    const init = await mcpInit(app.base);
    assert.equal(init.status, 200);
    assert.equal(init.json.result.serverInfo.name, 'ticket', '契约 5：serverName = ticket');
    assert.ok(init.json.result.protocolVersion, 'initialize 必须回 protocolVersion');

    const list = await mcp(app.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json.result.tools.map((t) => t.name);
    assert.equal(names.length, 10, `工具必须恰好 10 个（契约第 5 节），实际 ${names.length}: ${names.join(',')}`);
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort(), '工具名集合必须与契约第 5 节完全一致');
    // 不能多也不能少
    for (const n of EXPECTED_TOOLS) assert.ok(names.includes(n), `缺少工具 ${n}`);

    // 写工具的 schema 必须把 actor_id / actor_model 设为 required（契约 5 末段）
    const writeTools = ['ticket_create', 'ticket_update', 'ticket_delete', 'comment_add', 'comment_update', 'comment_delete'];
    for (const name of writeTools) {
      const tool = list.json.result.tools.find((t) => t.name === name);
      assert.ok(tool, `写工具 ${name} 必须存在`);
      const required = tool.inputSchema.required || [];
      assert.ok(required.includes('actor_id'), `${name} 的 schema 必须把 actor_id 设为 required`);
      assert.ok(required.includes('actor_model'), `${name} 的 schema 必须把 actor_model 设为 required`);
      assert.match(
        JSON.stringify(tool.inputSchema),
        /你自己的身份|actor_model/,
        `${name} 的描述里应写明"填你自己的身份和模型"（契约 5 末段）`,
      );
    }
    // 读工具不应要求 actor
    const readTools = ['workspace_list', 'ticket_list', 'ticket_get', 'comment_list'];
    for (const name of readTools) {
      const tool = list.json.result.tools.find((t) => t.name === name);
      const required = tool.inputSchema.required || [];
      assert.ok(!required.includes('actor_id'), `读工具 ${name} 不该强制要求身份`);
    }
  } finally {
    await app.close();
  }
});

test('ticket_list / ticket_get / comment_add 返回 content[0].type=text 且是纯文本（不是 JSON）', async () => {
  const app = await startTestApp();
  try {
    await mcpInit(app.base);
    // 先建一张工单（用 REST，避免被测工具互相依赖）
    const t = (
      await req(app.base, `/api/workspaces/${WS}/tickets`, {
        method: 'POST',
        body: { title: 'MCP 测试工单', body: '正文', priority: 2 },
      })
    ).body;

    // ticket_list
    const listResult = await mcpCall(app.base, 'ticket_list', { workspace: WS });
    assert.equal(listResult.content.length, 1, '返回单条 content');
    assert.equal(listResult.content[0].type, 'text', '契约 5：所有工具返回 content:[{type:"text"}]');
    const listText = listResult.content[0].text;
    assert.ok(!listText.trim().startsWith('{'), '绝不能返回 JSON —— 那等于把 token 浪费在括号引号上');
    assert.ok(!listText.trim().startsWith('['), '不能返回 JSON 数组');
    assert.ok(listText.startsWith(`# ai-mcp-ticket  workspace: ${WS}`), '必须是 4.2 格式的纯文本列表');
    assert.ok(listText.includes('    title: MCP 测试工单'), '要包含真实工单内容');
    assert.ok(listText.trimEnd().endsWith('# end. 用 ?status= 过滤，?format=text 强制纯文本'), '必须带结尾行');

    // ticket_get
    const getResult = await mcpCall(app.base, 'ticket_get', { ref: t.ref });
    assert.equal(getResult.content[0].type, 'text');
    const getText = getResult.content[0].text;
    assert.ok(!getText.trim().startsWith('{'));
    assert.ok(getText.startsWith(`# ai-mcp-ticket ticket: ${t.ref}`), '必须是 4.3 格式的单张纯文本');
    assert.ok(getText.includes(`id: ${t.id}`), '要带 uuid 供 AI 后续操作');

    // comment_add
    const addResult = await mcpCall(app.base, 'comment_add', {
      ref: t.ref,
      body: 'AI 通过 MCP 写的评论',
      actor_id: 'dsh-lead',
      actor_model: 'group/cherish-ai',
    });
    assert.equal(addResult.content[0].type, 'text');
    const addText = addResult.content[0].text;
    assert.ok(!addText.trim().startsWith('{'), 'comment_add 也必须返回纯文本');
    assert.ok(addText.includes('AI 通过 MCP 写的评论'), '返回的是该工单最新全文，必须含新评论');
    assert.ok(addText.includes('ai:dsh-lead (group/cherish-ai)'), '评论必须带上 model（审计）');
    assert.ok(addText.includes('## 评论 (1)'), '评论段条数应为 1');

    // 落库校验：REST 也能看到这条评论（MCP 与 REST 必须操作同一份数据）
    const viaRest = (await req(app.base, `/api/tickets/${t.id}/comments`)).body;
    assert.equal(viaRest.length, 1);
    assert.equal(viaRest[0].actor_id, 'dsh-lead');
    assert.equal(viaRest[0].model, 'group/cherish-ai');
  } finally {
    await app.close();
  }
});

test('写工具缺 actor_id / actor_model 返回 isError（而不是静默写成功）', async () => {
  const app = await startTestApp();
  try {
    await mcpInit(app.base);
    const t = (
      await req(app.base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: { title: '身份缺失' } })
    ).body;

    const cases = [
      ['ticket_create', { workspace: WS, title: 'x' }],
      ['ticket_update', { ref: t.ref, title: 'y' }],
      ['ticket_delete', { ref: t.ref }],
      ['comment_add', { ref: t.ref, body: 'z' }],
      ['comment_update', { comment_id: 'any', body: 'z' }],
      ['comment_delete', { comment_id: 'any' }],
    ];
    for (const [name, args] of cases) {
      const r = await mcpCall(app.base, name, args);
      assert.ok(r, `${name} 应返回 result`);
      assert.equal(r.isError, true, `${name} 缺 actor_id/actor_model 必须返回 isError（契约 5）`);
      assert.equal(r.content[0].type, 'text', `${name} 的错误也应是纯文本`);
      assert.ok(
        /actor_id|actor_model|身份|model/i.test(r.content[0].text),
        `${name} 的错误文案应指明缺身份，实际: ${r.content[0].text.slice(0, 120)}`,
      );
    }

    // 只给 actor_id 不给 model 也要 isError
    const half = await mcpCall(app.base, 'comment_add', { ref: t.ref, body: 'z', actor_id: 'dsh-lead' });
    assert.equal(half.isError, true, '只给 actor_id 不给 actor_model 必须报错');

    // 空串也不能混过去
    const empty = await mcpCall(app.base, 'ticket_create', {
      workspace: WS,
      title: 'x',
      actor_id: '',
      actor_model: '',
    });
    assert.equal(empty.isError, true, '空字符串身份必须被拒');

    // 失败不能留下脏数据
    const list = (await req(app.base, `/api/workspaces/${WS}/tickets`)).body.tickets;
    assert.equal(list.length, 1, '身份缺失的 ticket_create 不能建出工单');
    const comments = (await req(app.base, `/api/tickets/${t.id}/comments`)).body;
    assert.equal(comments.length, 0, '身份缺失的 comment_add 不能写出评论');
  } finally {
    await app.close();
  }
});

test('MCP 全套写操作：create → update → comment_add → comment_update → comment_delete → delete', async () => {
  const app = await startTestApp();
  try {
    await mcpInit(app.base);
    const AI = { actor_id: 'dsh-lead', actor_model: 'group/cherish-ai' };

    // create
    const created = await mcpCall(app.base, 'ticket_create', {
      workspace: WS,
      title: 'MCP 建的单',
      body: '正文',
      priority: 3,
      ...AI,
    });
    assert.ok(!created.isError, `ticket_create 不应失败: ${created.content?.[0]?.text}`);
    const createdText = created.content[0].text;
    assert.match(createdText, /^# ai-mcp-ticket ticket: demo-project#\d+/, '返回新工单纯文本');
    assert.ok(createdText.includes('priority: 紧急 (3)'), '优先级 3 应显示"紧急"');
    assert.ok(createdText.includes('by ai:dsh-lead (group/cherish-ai)'), '创建者与 model 要回显');
    const ref = /ticket: (\S+)/.exec(createdText)[1];

    // update
    const updated = await mcpCall(app.base, 'ticket_update', { ref, status: 'in_progress', ...AI });
    assert.ok(!updated.isError);
    assert.ok(updated.content[0].text.includes('status: 处理中 (in_progress)'), '状态必须真的改掉');
    assert.ok(updated.content[0].text.includes('## 评论 (0)'));

    // comment_add
    const c1 = await mcpCall(app.base, 'comment_add', { ref, body: '第一条 MCP 评论', ...AI });
    assert.ok(!c1.isError);
    assert.ok(c1.content[0].text.includes('## 评论 (1)'));

    // 从 REST 拿评论 id（MCP comment_list 里也有 id 行）
    const cList = await mcpCall(app.base, 'comment_list', { ref });
    assert.ok(!cList.isError);
    assert.ok(cList.content[0].text.includes('第一条 MCP 评论'));
    const commentId = /  id: (\S+)/.exec(cList.content[0].text)[1];
    assert.ok(commentId, 'comment_list 必须给出评论 id，否则 AI 无法改/删');

    // comment_update
    const cUpd = await mcpCall(app.base, 'comment_update', { comment_id: commentId, body: '改过的评论', ...AI });
    assert.ok(!cUpd.isError, `comment_update 不应失败: ${cUpd.content?.[0]?.text}`);
    assert.ok(cUpd.content[0].text.includes('改过的评论'), '改后的正文要回显');
    assert.ok(!cUpd.content[0].text.includes('第一条 MCP 评论'), '旧正文不应再出现');

    // comment_delete
    const cDel = await mcpCall(app.base, 'comment_delete', { comment_id: commentId, ...AI });
    assert.ok(!cDel.isError);
    assert.ok(cDel.content[0].text.includes('## 评论 (0)'), '删后评论数应回到 0');

    // ticket_delete
    const del = await mcpCall(app.base, 'ticket_delete', { ref, ...AI });
    assert.ok(!del.isError);
    assert.equal(del.content[0].text.trim(), `deleted: ${ref}`, '契约 5：ticket_delete 返回 `deleted: ref`');
    assert.equal((await req(app.base, `/api/tickets/${encodeURIComponent(ref)}`)).status, 404, '删后应 404');
  } finally {
    await app.close();
  }
});

test('MCP 读工具：workspace_list 与 ticket_list 的过滤/截断参数', async () => {
  const app = await startTestApp();
  try {
    await mcpInit(app.base);
    const ws = await mcpCall(app.base, 'workspace_list', {});
    assert.equal(ws.content[0].type, 'text');
    assert.ok(ws.content[0].text.startsWith('# ai-mcp-ticket 工作区索引'));
    assert.ok(ws.content[0].text.includes(WS), '要列出工作区');

    // 造两张工单，一张长正文
    await req(app.base, `/api/workspaces/${WS}/tickets`, {
      method: 'POST',
      body: { title: '短正文', body: '短' },
    });
    await req(app.base, `/api/workspaces/${WS}/tickets`, {
      method: 'POST',
      body: { title: '长正文', body: '很长'.repeat(500), status: 'done' },
    });

    // status 过滤
    const onlyOpen = await mcpCall(app.base, 'ticket_list', { workspace: WS, status: 'open' });
    assert.ok(onlyOpen.content[0].text.includes('count: 1'), 'status=open 只应有 1 条');
    assert.ok(onlyOpen.content[0].text.includes('# filter: status=open'), 'filter 行要回显生效的过滤');

    // maxlen 截断
    const trunc = await mcpCall(app.base, 'ticket_list', { workspace: WS, maxlen: 10 });
    assert.ok(trunc.content[0].text.includes('…(截断)'), 'maxlen 参数必须生效');

    // comments=0
    const noCmt = await mcpCall(app.base, 'ticket_list', { workspace: WS, comments: 0 });
    assert.ok(!noCmt.content[0].text.includes('comments('), 'comments=0 应隐藏评论块');

    // q 搜索
    const searched = await mcpCall(app.base, 'ticket_list', { workspace: WS, q: '长正文' });
    assert.ok(searched.content[0].text.includes('count: 1'), 'q 应命中 1 条');
  } finally {
    await app.close();
  }
});

test('MCP 错误路径：不存在的工作区 / 工单返回 isError 而不是 JSON-RPC 层异常', async () => {
  const app = await startTestApp();
  try {
    await mcpInit(app.base);

    const noWs = await mcpCall(app.base, 'ticket_list', { workspace: 'no-such-ws' });
    assert.equal(noWs.isError, true, '不存在的工作区必须 isError');
    assert.ok(!noWs.content[0].text.trim().startsWith('{'), '错误也必须是纯文本，不是 JSON');

    const noTicket = await mcpCall(app.base, 'ticket_get', { ref: `${WS}#9999` });
    assert.equal(noTicket.isError, true);
    assert.match(noTicket.content[0].text, /不存在|错误/);

    const badRef = await mcpCall(app.base, 'ticket_get', { ref: '完全没有井号的乱写' });
    assert.equal(badRef.isError, true, '格式不对的 ref 也要 isError，不能 500');

    const badStatus = await mcpCall(app.base, 'ticket_list', { workspace: WS, status: 'bogus' });
    // 契约 5 的 status 是自由字符串；无论实现选择报错还是忽略，都不能返回 JSON-RPC 层异常
    assert.ok(badStatus, '必须返回 result 而不是 JSON-RPC error');
  } finally {
    await app.close();
  }
});

test('GET / DELETE /mcp 返回 405 JSON（契约 5 传输约定）', async () => {
  const app = await startTestApp();
  try {
    const get = await req(app.base, '/mcp');
    assert.equal(get.status, 405, 'GET /mcp 必须 405（无状态模式不支持 SSE）');
    assert.equal(get.body.error.code, 'METHOD_NOT_ALLOWED');

    const del = await req(app.base, '/mcp', { method: 'DELETE' });
    assert.equal(del.status, 405, 'DELETE /mcp 必须 405（不支持会话删除）');
    assert.equal(del.body.error.code, 'METHOD_NOT_ALLOWED');
  } finally {
    await app.close();
  }
});
