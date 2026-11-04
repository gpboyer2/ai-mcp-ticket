// 认领（锁定）功能单测（契约 1.6 / 3.2.1）。
// 覆盖：认领、同 actor 幂等重认领、被别人认领时 409、认领者本人释放、
// 别人释放 409、过期自动失效（接管）、user 可覆盖 AI 的认领、写操作保护 409。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { req, startTestApp, mcpCall, AI_HEADERS } from './_helpers.js';

const WS = 'demo-project';

// 第二个 AI 身份（"别人"）
const OTHER_AI = Object.freeze({
  'X-Actor-Role': 'ai',
  'X-Actor-Id': 'claude',
  'X-Actor-Model': 'claude-sonnet-4.5',
});

async function createTicket(app, content = '认领测试工单') {
  const r = await req(app.base, `/api/workspaces/${WS}/tickets`, {
    method: 'POST',
    body: { content },
  });
  return r.body;
}

async function claim(app, id, headers = AI_HEADERS) {
  return req(app.base, `/api/tickets/${id}/claim`, { method: 'POST', headers });
}

async function release(app, id, headers = AI_HEADERS) {
  return req(app.base, `/api/tickets/${id}/release`, { method: 'POST', headers });
}

test('认领：POST claim 写入四列并返回工单 JSON', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    const r = await claim(app, t.id);
    assert.equal(r.status, 200, '认领应 200');
    assert.equal(r.body.assignee_id, 'deepseek');
    assert.equal(r.body.assignee_role, 'ai');
    assert.equal(r.body.assignee_model, 'deepseek-v4.1');
    assert.ok(typeof r.body.claimed_at === 'string' && r.body.claimed_at.endsWith('Z'), 'claimed_at 应为 ISO UTC');
    assert.equal(r.body.took_over, undefined, '正常认领不带 took_over');
  } finally {
    await app.close();
  }
});

test('同 actor 幂等重认领：返回 200 且刷新 claimed_at（不带 took_over）', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    const first = (await claim(app, t.id)).body;
    const again = (await claim(app, t.id)).body;
    assert.equal(again.assignee_id, 'deepseek');
    assert.equal(again.took_over, undefined, '幂等重认领不带 took_over');
    // 进程内单调时钟保证续期到"不早于"首次认领时间
    assert.ok(
      Date.parse(again.claimed_at) >= Date.parse(first.claimed_at),
      `重认领应刷新 claimed_at（首次 ${first.claimed_at} → 再次 ${again.claimed_at}）`,
    );
  } finally {
    await app.close();
  }
});

test('被别人认领时再认领 → 409 TICKET_CLAIMED，错误信息含认领者 id/role/model 与时间', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    const c = await claim(app, t.id); // deepseek 认领
    assert.equal(c.status, 200);
    const other = await claim(app, t.id, OTHER_AI); // claude 来抢
    assert.equal(other.status, 409, '应 409');
    assert.equal(other.body.error.code, 'TICKET_CLAIMED');
    const msg = other.body.error.message;
    for (const piece of ['deepseek', 'ai', 'deepseek-v4.1']) {
      assert.ok(msg.includes(piece), `错误信息应含认领者信息「${piece}」，实际: ${msg}`);
    }
    assert.ok(msg.includes(c.body.claimed_at), `错误信息应含认领时间，实际: ${msg}`);
  } finally {
    await app.close();
  }
});

test('认领者本人释放：四列置 NULL，返回 200', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id);
    const r = await release(app, t.id);
    assert.equal(r.status, 200, '释放应 200');
    assert.equal(r.body.assignee_id, null);
    assert.equal(r.body.assignee_role, null);
    assert.equal(r.body.assignee_model, null);
    assert.equal(r.body.claimed_at, null);
  } finally {
    await app.close();
  }
});

test('别人（另一 AI）释放被认领的工单 → 409 TICKET_CLAIMED', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id); // deepseek 认领
    const other = await release(app, t.id, OTHER_AI); // claude 来释放
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'TICKET_CLAIMED');
  } finally {
    await app.close();
  }
});

test('认领过期自动失效：claimed_at 远超 CLAIM_STALE_MS 后，别人可接管（took_over=true）', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id); // deepseek 认领
    // 把认领时间拨到 100 天前，必然过期
    app.inst.db.prepare('UPDATE tickets SET claimed_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), t.id);
    const other = await claim(app, t.id, OTHER_AI); // claude 接管
    assert.equal(other.status, 200, '过期后接管应 200');
    assert.equal(other.body.assignee_id, 'claude', '接管后认领者应为 claude');
    assert.equal(other.body.took_over, true, '过期接管应带 took_over=true');
  } finally {
    await app.close();
  }
});

test('过期失效后，别的 AI 也能 PATCH（写操作保护不触发）', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id);
    app.inst.db.prepare('UPDATE tickets SET claimed_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), t.id);
    const p = await req(app.base, `/api/tickets/${t.id}`, {
      method: 'PATCH',
      body: { content: '被接管后改的内容' },
      headers: OTHER_AI,
    });
    assert.equal(p.status, 200, '过期认领下别的 AI 应能 PATCH');
    assert.equal(p.body.content, '被接管后改的内容');
  } finally {
    await app.close();
  }
});

test('user 可覆盖 AI 的认领：PATCH 被 AI 认领的工单 → 200', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id); // AI 认领
    const p = await req(app.base, `/api/tickets/${t.id}`, {
      method: 'PATCH',
      body: { content: '用户强行改的' },
      // 不带任何 actor 头 → role=user（老板）
    });
    assert.equal(p.status, 200, '用户应能覆盖 AI 的认领');
    assert.equal(p.body.content, '用户强行改的');
  } finally {
    await app.close();
  }
});

test('user 可释放 AI 的认领：release 被 AI 认领的工单 → 200', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id);
    const r = await req(app.base, `/api/tickets/${t.id}/release`, { method: 'POST' });
    assert.equal(r.status, 200, '用户应能释放任何人的认领');
    assert.equal(r.body.assignee_id, null);
  } finally {
    await app.close();
  }
});

test('写操作保护：被 AI 认领且未过期时，别的 AI 的 PATCH/评论 → 409', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id); // deepseek 认领，未过期
    const patch = await req(app.base, `/api/tickets/${t.id}`, {
      method: 'PATCH', body: { content: '想改' }, headers: OTHER_AI,
    });
    assert.equal(patch.status, 409, '别的 AI PATCH 应 409');
    const comment = await req(app.base, `/api/tickets/${t.id}/comments`, {
      method: 'POST', body: { body: '想评论' }, headers: OTHER_AI,
    });
    assert.equal(comment.status, 409, '别的 AI 评论应 409');

    // MCP 那条路也必须受同一条规则约束（契约 1.6 第 6 条没给 MCP 开例外）。
    // 原来 MCP comment_add 完全绕过了认领保护，REST 拦住、MCP 放行 —— 现在共用 comments.create 里那一份。
    const viaMcp = await mcpCall(app.base, 'comment_add', {
      ref: t.ref,
      body: '想通过 MCP 评论',
      status: 'in_progress',
      actor_id: 'claude',
      actor_model: 'claude-sonnet-4.5',
    });
    assert.equal(viaMcp.isError, true, 'MCP 也必须被认领保护拦住');
    assert.match(viaMcp.content[0].text, /认领/, `错误文案应说明被认领：${viaMcp.content[0].text}`);
  } finally {
    await app.close();
  }
});

test('删除不受认领限制：被 AI 认领时，任何人都可 DELETE 成功（用户清理动作不能被卡）', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id); // AI 认领，未过期
    // 别的 AI 也能删（DELETE 不在写保护范围）
    const delByOther = await req(app.base, `/api/tickets/${t.id}`, { method: 'DELETE', headers: OTHER_AI });
    assert.equal(delByOther.status, 200, '被认领时别的 AI 也应能删除');
    assert.equal((await req(app.base, `/api/tickets/${t.id}`)).status, 404, '删后取单条应 404');

    // 用户也能删（不论是否被认领）
    const t2 = await createTicket(app);
    await claim(app, t2.id);
    const delByUser = await req(app.base, `/api/tickets/${t2.id}`, { method: 'DELETE' });
    assert.equal(delByUser.status, 200, '被认领时用户也应能删除');
  } finally {
    await app.close();
  }
});

test('写操作保护不误伤：认领者本人仍可 PATCH/评论', async () => {
  const app = await startTestApp();
  try {
    const t = await createTicket(app);
    await claim(app, t.id); // deepseek 认领
    const patch = await req(app.base, `/api/tickets/${t.id}`, {
      method: 'PATCH', body: { content: '认领者自己改' }, headers: AI_HEADERS,
    });
    assert.equal(patch.status, 200);
    // 评论带 status=in_progress：契约 5.5.2 的硬门要求 AI 在「打开」的单上先表态
    const comment = await req(app.base, `/api/tickets/${t.id}/comments`, {
      method: 'POST', body: { body: '认领者自己评论', status: 'in_progress' }, headers: AI_HEADERS,
    });
    assert.equal(comment.status, 201);
  } finally {
    await app.close();
  }
});

test('数据库迁移：老 v1 库（title+body、无认领四列）一路升到 v3，内容不丢', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-mig-'));
  const p = path.join(dir, 'old.db');
  // 造一个 v1 老库：tickets 只有原始 12 列，且已有真实工单，user_version=1
  const old = new Database(p);
  old.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL);
    CREATE TABLE ticket_seq (workspace_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 1, position REAL NOT NULL, blocked_by TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL, actor_role TEXT NOT NULL CHECK (actor_role IN ('user','ai')), model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE comments (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, body TEXT NOT NULL, actor_id TEXT NOT NULL, actor_role TEXT NOT NULL CHECK (actor_role IN ('user','ai')), model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE actors (id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','ai')), model TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('w1','demo','Demo','/tmp/demo',0,'2026-11-04T00:00:00.000Z');
    INSERT INTO tickets (id,workspace_id,seq,title,position,actor_id,actor_role,created_at,updated_at) VALUES ('t1','w1',1,'老数据保命','1024','deepseek','ai','2026-11-04T00:00:00.000Z','2026-11-04T00:00:00.000Z');
    PRAGMA user_version = 1;
  `);
  old.close();

  try {
    // 连两次，验证迁移幂等（第二次不应重复 ALTER / 重建 / 不报错）
    let db = openDb(p);
    assert.equal(db.pragma('user_version', { simple: true }), 3, '应一路升到 schema v3');
    db.close();
    db = openDb(p);
    const cols = db.pragma('table_info(tickets)').map((c) => c.name);
    for (const col of ['assignee_id', 'assignee_role', 'assignee_model', 'claimed_at', 'content']) {
      assert.ok(cols.includes(col), `缺列 ${col}`);
    }
    assert.ok(!cols.includes('title') && !cols.includes('body'), 'title / body 两列必须彻底移除（契约 1.3）');
    const row = db.prepare('SELECT content, assignee_id FROM tickets WHERE id = ?').get('t1');
    assert.equal(row.content, '老数据保命', '老数据应保留（body 为空时 content 就是 title）');
    assert.equal(row.assignee_id, null, '新列默认 NULL');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
