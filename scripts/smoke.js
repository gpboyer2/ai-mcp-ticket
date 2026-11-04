// 端到端冒烟：对着一个**真实运行**的实例跑完整业务流（默认 http://127.0.0.1:47321）。
// 用法：
//   node scripts/smoke.js                        # 打默认端口 47321（真实实例）
//   PORT=47399 node scripts/smoke.js             # 打指定端口（自测实例）
//   BASE=http://127.0.0.1:8080 node scripts/smoke.js   # 打任意地址（优先于 PORT）
//
// 为什么同时认 PORT 和 BASE：本项目其他所有地方（server.js / ticket.sh）统一用 PORT 表达端口，
// 只有这里原来单认 BASE —— 于是 `PORT=47399 node scripts/smoke.js` 会被静默忽略，
// 转头去打 47321 的真实实例。自测脚本打穿用户真实环境，比测不出来严重得多。
// 现在两个都认，且默认端口取自 src/port.js 的单一常量，不在这里另写一个 47321。
//
// 与 tests/ 的分工：tests/ 起临时库、只测单点；这里打真实例、测"整条链路能不能通"，
// 因为它验证的是真实部署形态（真端口、真静态文件、真 MCP 端点、真 DSH 工作区）。
//
// 每条断言都打印 ✔/✘ 与耗时；任何一条失败 → 汇总后以非 0 退出。
import process from 'node:process';
import path from 'node:path';
import { resolvePort } from '../src/port.js';
import { DEFAULT_DB_PATH } from '../src/db.js';

const BASE = (
  process.env.BASE || `http://127.0.0.1:${resolvePort(process.env.PORT)}`
).replace(/\/+$/, '');
const AI_ID = process.env.SMOKE_ACTOR_ID || 'smoke-runner';
const AI_MODEL = process.env.SMOKE_ACTOR_MODEL || 'deepseek-v4.1';

// ---------- 结果记录 ----------
const results = [];
let failed = 0;
// healthz 报出来的真实 db 路径，供「别打穿真实库」护栏判定
let aliveDb = '';

/** 跑一个步骤：自动计时、打印 ✔/✘，失败时记录原因（不中断，跑完统一汇总） */
async function step(name, fn) {
  const t0 = process.hrtime.bigint();
  try {
    const detail = await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    results.push({ name, ok: true, ms, detail });
    console.log(`  ✔ ${name}${detail ? `  — ${detail}` : ''}  (${ms.toFixed(0)}ms)`);
    return true;
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    results.push({ name, ok: false, ms, error: e.message });
    console.log(`  ✘ ${name}  (${ms.toFixed(0)}ms)`);
    console.log(`      原因: ${e.message}`);
    failed++;
    return false;
  }
}

// ---------- 断言小工具（失败时给出可定位的信息） ----------
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}
function mustEq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function mustMatch(text, re, what) {
  if (!re.test(text)) throw new Error(`${what}：正文里没匹配到 ${re}\n      实际片段: ${String(text).slice(0, 400)}`);
}
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- HTTP 小工具 ----------
async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + pathname, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** 带 AI 身份头的请求（契约 2：role=ai 必须带 id + model） */
const asAi = (extra = {}) => ({
  'X-Actor-Role': 'ai',
  'X-Actor-Id': AI_ID,
  'X-Actor-Model': AI_MODEL,
  ...extra,
});

/** 纯文本请求（模拟 AI 的 fetch 习惯） */
async function fetchText(pathname) {
  const res = await fetch(BASE + pathname, { headers: { Accept: 'text/plain' } });
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

/** MCP JSON-RPC 调用 */
async function mcp(payload) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`MCP 响应不是 JSON（HTTP ${res.status}）: ${text.slice(0, 300)}`);
  }
  return json;
}

// ---------- 主流程 ----------
async function main() {
  console.log(`\n冒烟目标: ${BASE}`);
  console.log(`AI 身份: ${AI_ID} / ${AI_MODEL}\n`);

  // 0. 先确认实例活着，否则后面的报错会误导成"业务 bug"
  const alive = await step('实例可达 (GET /healthz)', async () => {
    const r = await api('/healthz');
    mustEq(r.status, 200, 'HTTP 状态码');
    must(r.json?.ok === true, 'healthz 的 ok 必须是 true');
    aliveDb = String(r.json.db || '');
    return `v${r.json.version} db=${r.json.db}`;
  });
  if (!alive) {
    console.log('\n实例不可达，后续步骤全部跳过。请先 npm start。\n');
    return summarize();
  }

  // 0.5 护栏：冒烟会真的建单、改单、删单。打在用户的真实库上会留下痕迹、并搅动真实数据。
  // 判据取 healthz 报的 db 路径，而不是靠人记得传对端口 —— 传错端口正是踩过的坑。
  // 真实例冒烟是发布前该做的事，所以不禁止，但要显式确认（SMOKE_ALLOW_REAL_DB=1）。
  const targetDb = String(aliveDb || '');
  const projectDb = path.resolve(DEFAULT_DB_PATH);
  if (targetDb && path.resolve(targetDb) === projectDb && !process.env.SMOKE_ALLOW_REAL_DB) {
    console.log(
      `\n✘ 冒烟会写数据，但目标是真实库：\n    ${targetDb}\n\n` +
        '  确实要对着真实例冒烟（发布前验证），加环境变量再跑：\n' +
        '    SMOKE_ALLOW_REAL_DB=1 node scripts/smoke.js\n' +
        '  只想自测，请另起临时库实例（DB_PATH=临时路径 PORT=自选端口），再用 PORT= 指过来。\n',
    );
    process.exitCode = 1;
    return summarize();
  }

  // 1. 工作区列表
  let wsSlug = null;
  await step('工作区列表 (GET /api/workspaces)', async () => {
    const r = await api('/api/workspaces');
    mustEq(r.status, 200, 'HTTP 状态码');
    must(Array.isArray(r.json), '响应必须是数组');
    must(r.json.length > 0, '没有任何工作区 —— 请先确认 DSH 的 workspace.json 已同步');
    wsSlug = r.json[0].slug;
    must(typeof wsSlug === 'string' && wsSlug.length > 0, '工作区必须有 slug');
    const total = r.json.reduce((n, w) => n + (w.ticket_counts?.total || 0), 0);
    return `${r.json.length} 个工作区（共 ${total} 张工单），选用 ${wsSlug}`;
  });
  if (!wsSlug) return summarize();

  // 2. 建工单（AI 身份）
  let ticket = null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const content = `[smoke] 端到端冒烟 ${stamp}\n\n这是冒烟脚本创建并会自动删除的工单。\n第二行内容。`;
  await step('建工单 (POST /api/workspaces/:ws/tickets, AI 身份)', async () => {
    const r = await api(`/api/workspaces/${encodeURIComponent(wsSlug)}/tickets`, {
      method: 'POST',
      headers: asAi(),
      body: { content, priority: 2 },
    });
    mustEq(r.status, 201, 'HTTP 状态码');
    ticket = r.json;
    mustEq(ticket.actor_role, 'ai', '创建者角色');
    mustEq(ticket.actor_id, AI_ID, '创建者 id');
    mustEq(ticket.model, AI_MODEL, '创建者 model');
    mustEq(ticket.status, 'open', '默认状态');
    mustEq(ticket.priority, 2, '优先级');
    mustMatch(ticket.ref, new RegExp(`^${escRe(wsSlug)}#\\d+$`), 'ref 形态 {slug}#{seq}');
    return `${ticket.ref} pos=${ticket.position}`;
  });
  if (!ticket) return summarize();

  // 3. 用户加评论
  await step('用户加评论 (POST /api/tickets/:id/comments, 无身份头 → user)', async () => {
    const r = await api(`/api/tickets/${ticket.id}/comments`, {
      method: 'POST',
      body: { body: '冒烟：这是用户本人写的评论' },
    });
    mustEq(r.status, 201, 'HTTP 状态码');
    mustEq(r.json.actor_id, 'user', '不带身份头时应归一成 user');
    mustEq(r.json.actor_role, 'user', '角色');
    mustEq(r.json.model, null, 'user 的 model 必须是 null');
    return `comment=${String(r.json.id).slice(0, 8)}…`;
  });

  // 4. AI 加评论（必须记录 model）
  await step('AI 加评论 (带 X-Actor-Id/Model)', async () => {
    const r = await api(`/api/tickets/${ticket.id}/comments`, {
      method: 'POST',
      headers: asAi(),
      body: { body: '冒烟：这是 AI 写的评论' },
    });
    mustEq(r.status, 201, 'HTTP 状态码');
    mustEq(r.json.actor_role, 'ai', '角色');
    mustEq(r.json.model, AI_MODEL, 'AI 评论必须记录 model（审计事实）');
    return `${r.json.actor_id} (${r.json.model})`;
  });

  // 4.5 关键：评论写入后工单 updated_at 必须前进（AI 靠它判断有没有新动静）
  await step('评论写入后工单 updated_at 必须变化', async () => {
    const r = await api(`/api/tickets/${ticket.id}`);
    mustEq(r.status, 200, 'HTTP 状态码');
    must(
      r.json.updated_at > ticket.updated_at,
      `updated_at 没前进：建单时 ${ticket.updated_at}，加完评论还是 ${r.json.updated_at}（AI 会以为没新消息）`,
    );
    return `${ticket.updated_at} → ${r.json.updated_at}`;
  });

  // 5. 改状态为 in_progress
  await step('改状态 → in_progress (PATCH)', async () => {
    const r = await api(`/api/tickets/${ticket.id}`, {
      method: 'PATCH',
      headers: asAi(),
      body: { status: 'in_progress' },
    });
    mustEq(r.status, 200, 'HTTP 状态码');
    mustEq(r.json.status, 'in_progress', '状态');
    must(Number(r.json.position) > 0, `换列后 position 应为正数，实际 ${r.json.position}`);
    return `pos=${ticket.position} → ${r.json.position}`;
  });

  // 6. 拖拽式 PATCH position
  await step('拖拽式 PATCH position（显式传 position 必须被尊重）', async () => {
    const r = await api(`/api/tickets/${ticket.id}`, {
      method: 'PATCH',
      headers: asAi(),
      body: { status: 'in_progress', position: 300 },
    });
    mustEq(r.status, 200, 'HTTP 状态码');
    mustEq(r.json.position, 300, '显式传入的 position 必须原样保存（拖拽语义）');
    mustEq(r.json.status, 'in_progress', '状态不应被改坏');
    return 'position=300';
  });

  // 7. 拉纯文本列表，核对含两条评论
  await step('纯文本列表含两条评论 (GET /{ws}/list, Accept: text/plain)', async () => {
    const r = await fetchText(`/${encodeURIComponent(wsSlug)}/list?status=in_progress`);
    mustEq(r.status, 200, 'HTTP 状态码');
    must(r.contentType.startsWith('text/plain'), `Content-Type 应为 text/plain，实际 ${r.contentType}`);
    mustMatch(r.text, /^# ai-mcp-ticket {2}workspace: /m, '首行 workspace 头（契约 4.2）');
    mustMatch(r.text, new RegExp(`\\[\\d+\\] ${escRe(ticket.ref)} {2}处理中 {2}优先级:高 {2}更新:`), '条目首行格式');
    must(r.text.includes('    content: [smoke] 端到端冒烟'), '列表里必须能找到刚建的工单（content 行）');
    must(r.text.includes('    comments(2):'), '评论块应显示 2 条');
    must(r.text.includes('冒烟：这是用户本人写的评论'), '用户的评论要出现在纯文本里');
    must(r.text.includes('冒烟：这是 AI 写的评论'), 'AI 的评论要出现在纯文本里');
    mustMatch(r.text, new RegExp(`ai:${escRe(AI_ID)} \\(${escRe(AI_MODEL)}\\)`), 'AI 评论必须带 model');
    must(
      r.text.trimEnd().endsWith('# end. 用 ?status= 过滤，?format=text 强制纯文本'),
      '末尾必须是契约 4.2 的固定行',
    );
    return `${r.text.split('\n').length} 行纯文本`;
  });

  // 8. 拉单工单纯文本
  await step('单工单纯文本 (GET /{ws}/t/{seq}.txt)', async () => {
    const r = await fetchText(`/${encodeURIComponent(wsSlug)}/t/${ticket.seq}.txt`);
    mustEq(r.status, 200, 'HTTP 状态码');
    must(r.contentType.startsWith('text/plain'), `Content-Type 应为 text/plain，实际 ${r.contentType}`);
    mustMatch(r.text, new RegExp(`^# ai-mcp-ticket ticket: ${escRe(ticket.ref)}$`, 'm'), '首行（契约 4.3）');
    must(r.text.includes('status: 处理中 (in_progress)'), '状态行必须含中英文');
    must(r.text.includes('## 内容'), '必须有内容段');
    must(r.text.includes('第二行内容。'), '内容段必须包含建单时写的全部内容');
    must(r.text.includes('## 评论 (2)'), '必须有评论段且条数为 2');
    must(r.text.includes(`id: ${ticket.id}`), '必须给出 uuid，AI 写评论要用');
    return '格式符合 4.3';
  });

  // 9. MCP initialize / tools_list / comment_add
  await step('MCP initialize', async () => {
    const r = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1.0.0' },
      },
    });
    must(r.result, `initialize 失败: ${JSON.stringify(r).slice(0, 300)}`);
    mustEq(r.result.serverInfo.name, 'ticket', 'MCP serverName（契约 5）');
    return `${r.result.serverInfo.name} v${r.result.serverInfo.version}`;
  });

  await step('MCP tools/list 恰好 12 个工具且名字符合契约第 5 节', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (r.result?.tools || []).map((t) => t.name).sort();
    const expected = [
      'comment_add',
      'comment_delete',
      'comment_list',
      'comment_update',
      'ticket_claim',
      'ticket_create',
      'ticket_delete',
      'ticket_get',
      'ticket_list',
      'ticket_release',
      'ticket_update',
      'workspace_list',
    ];
    mustEq(names.length, 12, '工具数量');
    mustEq(names.join(','), expected.join(','), '工具名集合');
    return names.join(', ');
  });

  await step('MCP comment_add 返回纯文本（不是 JSON）', async () => {
    const r = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'comment_add',
        arguments: { ref: ticket.ref, body: '冒烟：这是通过 MCP 加的评论', actor_id: AI_ID, actor_model: AI_MODEL },
      },
    });
    must(r.result, `tools/call 失败: ${JSON.stringify(r).slice(0, 300)}`);
    must(r.result.isError !== true, `工具返回 isError: ${r.result.content?.[0]?.text}`);
    const c = r.result.content?.[0];
    mustEq(c?.type, 'text', 'content[0].type（契约 5 要求纯文本）');
    must(!c.text.trim().startsWith('{'), 'MCP 工具绝不能返回 JSON —— 那是本项目的核心取舍');
    mustMatch(c.text, /^# ai-mcp-ticket ticket: /, '应返回该工单最新纯文本');
    must(c.text.includes('冒烟：这是通过 MCP 加的评论'), '返回文本里必须含新评论');
    must(c.text.includes('## 评论 (3)'), '评论数应为 3（用户 + AI + MCP）');
    return '纯文本 + 含新评论';
  });

  // 9.5 MCP comment_list 拿到 MCP 那条评论的 id（用于第 10 步删除）
  let mcpCommentId = null;
  await step('MCP comment_list 能拿到评论 id', async () => {
    const r = await mcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'comment_list', arguments: { ref: ticket.ref } },
    });
    const text = r.result?.content?.[0]?.text || '';
    must(!r.result?.isError, `comment_list 报错: ${text}`);
    // comment_list 的每条评论都带 `  id: <uuid>`，取最后一条（MCP 刚加的）
    const ids = [...text.matchAll(/^ {2}id: (\S+)$/gm)].map((m) => m[1]);
    mustEq(ids.length, 3, '评论条数');
    mcpCommentId = ids[ids.length - 1];
    must(/^[0-9a-f-]{36}$/.test(mcpCommentId), `评论 id 应是 uuid，实际 ${mcpCommentId}`);
    return `id=${mcpCommentId.slice(0, 8)}…`;
  });

  // 10. 删评论（删 MCP 那条，验证 comment_delete 与 updated_at 联动）
  await step('删评论 (MCP comment_delete)', async () => {
    must(mcpCommentId, '上一步没拿到评论 id，无法删除');
    const r = await mcp({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'comment_delete',
        arguments: { comment_id: mcpCommentId, actor_id: AI_ID, actor_model: AI_MODEL },
      },
    });
    must(!r.result?.isError, `comment_delete 报错: ${r.result?.content?.[0]?.text}`);
    const text = r.result.content[0].text;
    must(!text.includes('冒烟：这是通过 MCP 加的评论'), '删掉的评论不应再出现在返回文本里');
    must(text.includes('## 评论 (2)'), '删后评论数应回到 2');
    return '剩余 2 条';
  });

  // 11. 删工单
  await step('删工单 (DELETE /api/tickets/:id)', async () => {
    const r = await api(`/api/tickets/${ticket.id}`, { method: 'DELETE', headers: asAi() });
    mustEq(r.status, 200, 'HTTP 状态码');
    mustEq(r.json.deleted, true, 'deleted 标志');
    mustEq(r.json.ref, ticket.ref, '返回的 ref 应是被删的那张');
    return `已删 ${ticket.ref}`;
  });

  // 12. 确认纯文本列表里没了
  await step('确认纯文本列表里已找不到该工单', async () => {
    const r = await fetchText(`/${encodeURIComponent(wsSlug)}/list?status=in_progress`);
    mustEq(r.status, 200, 'HTTP 状态码');
    must(!r.text.includes(ticket.ref), `列表里还能看到 ${ticket.ref}，删除没生效`);
    must(!r.text.includes(stamp), '列表里还能看到冒烟工单的内容');
    // 单工单也应是 404
    const one = await fetchText(`/${encodeURIComponent(wsSlug)}/t/${ticket.seq}.txt`);
    mustEq(one.status, 404, '删后单工单纯文本应 404');
    return '列表与单条都已消失';
  });

  return summarize();
}

function summarize() {
  const total = results.length;
  const ok = total - failed;
  const totalMs = results.reduce((n, r) => n + r.ms, 0);
  console.log('\n' + '─'.repeat(64));
  console.log(`冒烟总结: ${ok}/${total} 通过，${failed} 失败，总耗时 ${totalMs.toFixed(0)}ms`);
  if (failed) {
    console.log('\n失败项:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  ✘ ${r.name}\n      ${r.error}`);
  }
  console.log('─'.repeat(64) + '\n');
  // 退出码只在这里定，且不覆盖调用方已设过的非 0（例如护栏拒绝跑）。
  // 原来无条件写 `failed ? 1 : 0`，会把「被拦住没跑」洗成「跑完全绿」，CI 假通过。
  process.exitCode = failed || process.exitCode ? 1 : 0;
  return failed === 0;
}

// 未捕获异常也要以非 0 退出，别让 CI 误判为通过
process.on('uncaughtException', (e) => {
  console.error('\n冒烟脚本异常终止:', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('\n冒烟脚本未处理的 Promise 拒绝:', e);
  process.exit(1);
});

await main();
