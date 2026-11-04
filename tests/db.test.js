// db / 建表幂等（契约 0、1.3、1.4）。
// 为什么单独测：建表跑两次不炸是"进程能反复重启"的底线，脏了就再也起不来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, resolveDbPath, SCHEMA_VERSION, nowIso, newId } from '../src/db.js';

test('同一路径建库两次不报错，表结构齐全（幂等）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-db-'));
  const dbPath = path.join(dir, 'ticket.db');
  try {
    // 第一次：全新库
    const db1 = openDb(dbPath);
    const tables1 = db1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    // 断言：五张业务表都在（少一张就有功能会 500）
    assert.deepEqual(
      tables1,
      ['actors', 'comments', 'ticket_seq', 'tickets', 'workspaces'],
      `建表后应恰好有这五张业务表，实际 ${JSON.stringify(tables1)}`,
    );
    assert.equal(db1.pragma('user_version', { simple: true }), SCHEMA_VERSION, '建库后 user_version 应等于 SCHEMA_VERSION');
    assert.equal(db1.pragma('journal_mode', { simple: true }), 'wal', '契约 0 要求 WAL 模式');
    assert.equal(db1.pragma('foreign_keys', { simple: true }), 1, '外键必须打开，否则级联删除失效');
    db1.close();

    // 第二次：同一个文件再开一遍，绝不能抛（migrate 会走 from >= SCHEMA_VERSION 的早退分支）
    const db2 = openDb(dbPath);
    const tables2 = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(tables2, tables1, '第二次打开不应新增/丢失任何表');
    assert.equal(db2.pragma('user_version', { simple: true }), SCHEMA_VERSION);

    // 第三次：库里已有数据时再开，数据必须还在（迁移不能清表）
    db2.prepare(
      "INSERT INTO workspaces (id, slug, title, path, archived, synced_at) VALUES ('w','s','t','/p',0,'2026-01-01T00:00:00.000Z')",
    ).run();
    db2.close();
    const db3 = openDb(dbPath);
    const row = db3.prepare("SELECT slug FROM workspaces WHERE id='w'").get();
    assert.equal(row?.slug, 's', '重复建表不得清空既有数据');
    db3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('父目录不存在时自动创建（首次启动 data/ 还没建）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-db-'));
  const deep = path.join(dir, 'a', 'b', 'c', 'ticket.db');
  try {
    assert.equal(fs.existsSync(path.dirname(deep)), false, '前置条件：目录确实还不存在');
    const db = openDb(deep);
    assert.equal(fs.existsSync(deep), true, 'openDb 应递归创建父目录');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDbPath：显式参数 > DB_PATH 环境变量 > 默认路径，且相对路径被绝对化', () => {
  const old = process.env.DB_PATH;
  try {
    assert.equal(resolveDbPath('/abs/x.db'), path.resolve('/abs/x.db'));
    process.env.DB_PATH = '/env/y.db';
    assert.equal(resolveDbPath(), path.resolve('/env/y.db'), '没传参数时应读 DB_PATH');
    assert.equal(resolveDbPath('/explicit/z.db'), path.resolve('/explicit/z.db'), '显式参数优先级最高');
    assert.equal(resolveDbPath('rel/w.db'), path.resolve('rel/w.db'), '相对路径必须解析成绝对路径');
    assert.equal(resolveDbPath(':memory:'), ':memory:', '内存库不能被 path.resolve 改写');
  } finally {
    if (old === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = old;
  }
});

test('约束真的生效：非法 status / priority 越界被数据库拦住', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-db-'));
  const db = openDb(path.join(dir, 'ticket.db'));
  try {
    db.prepare(
      "INSERT INTO workspaces (id, slug, title, path, archived, synced_at) VALUES ('w','s','t','/p',0,?)",
    ).run(nowIso());
    const insert = (status, priority) =>
      db
        .prepare(
          `INSERT INTO tickets (id, workspace_id, seq, content, status, priority, position, blocked_by,
                                actor_id, actor_role, model, created_at, updated_at)
           VALUES (?, 'w', ?, 'x', ?, ?, 1, '', 'user', 'user', NULL, ?, ?)`,
        )
        .run(newId(), Math.floor(Math.random() * 1e9), status, priority, nowIso(), nowIso());

    assert.throws(() => insert('bogus', 1), /CHECK constraint failed/, 'status 只能是五值之一');
    assert.throws(() => insert('open', 4), /CHECK constraint failed/, 'priority 只能 0..3');
    assert.throws(() => insert('open', -1), /CHECK constraint failed/, 'priority 不能为负');
    // 合法值必须能写进去，否则上面的 throws 可能是别的原因
    assert.doesNotThrow(() => insert('open', 0));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// v2 结构：tickets 有 title / body 两列，没有 content。迁移到 v3 必须把两列合并成 content 且不丢行。
// 为什么单独测：这是唯一会重写整张 tickets 表的迁移，写错就是用户真实工单没了。
function makeV2Db(dbPath) {
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL);
    CREATE TABLE ticket_seq (workspace_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, seq INTEGER NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 1,
      position REAL NOT NULL, blocked_by TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL, actor_role TEXT NOT NULL CHECK (actor_role IN ('user','ai')), model TEXT,
      assignee_id TEXT, assignee_role TEXT CHECK (assignee_role IN ('user','ai')), assignee_model TEXT, claimed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE comments (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, body TEXT NOT NULL, actor_id TEXT NOT NULL, actor_role TEXT NOT NULL CHECK (actor_role IN ('user','ai')), model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE actors (id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','ai')), model TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    CREATE UNIQUE INDEX tickets_ws_seq ON tickets(workspace_id, seq);
    CREATE INDEX tickets_ws_status ON tickets(workspace_id, status, position);
    CREATE INDEX tickets_ws_updated ON tickets(workspace_id, updated_at);
    INSERT INTO workspaces VALUES ('w1','demo','Demo','/tmp/demo',0,'2026-11-04T00:00:00.000Z');
    INSERT INTO tickets (id, workspace_id, seq, title, body, status, priority, position, blocked_by,
                         actor_id, actor_role, model, created_at, updated_at)
      VALUES ('t1','w1',1,'只有标题','','open',1,1024,'','user','user',NULL,'2026-11-04T00:00:00.000Z','2026-11-04T00:00:00.000Z'),
             ('t2','w1',2,'标题','正文第一行\n第二行','in_progress',2,2048,'demo#1','ai','ai','deepseek-v4.1','2026-11-04T00:00:01.000Z','2026-11-04T00:00:01.000Z');
    INSERT INTO comments VALUES ('c1','t2','老评论','user','user',NULL,'2026-11-04T00:00:02.000Z','2026-11-04T00:00:02.000Z');
    PRAGMA user_version = 2;
  `);
  old.close();
}

test('迁移 v2 → v3：title+body 合并成 content，两列移除，行数与评论都不丢', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-db-mig-'));
  const dbPath = path.join(dir, 'v2.db');
  try {
    makeV2Db(dbPath);

    // 前置事实：v2 库确实有 title/body、没有 content
    const before = new Database(dbPath);
    const beforeCols = before.pragma('table_info(tickets)').map((c) => c.name);
    assert.ok(beforeCols.includes('title') && beforeCols.includes('body'), '前置条件：v2 库应有 title/body');
    assert.ok(!beforeCols.includes('content'), '前置条件：v2 库不应有 content');
    const beforeCount = before.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
    before.close();
    assert.equal(beforeCount, 2);

    // 迁移
    let db = openDb(dbPath);
    assert.equal(db.pragma('user_version', { simple: true }), 3, '应升到 schema v3');
    const cols = db.pragma('table_info(tickets)').map((c) => c.name);
    assert.ok(cols.includes('content'), '迁移后必须有 content 列');
    assert.ok(!cols.includes('title'), 'title 列必须彻底移除（契约 1.3：不留假兼容列）');
    assert.ok(!cols.includes('body'), 'body 列必须彻底移除');

    const rows = db.prepare('SELECT id, content, status, priority, blocked_by, actor_id, actor_role, model FROM tickets ORDER BY seq').all();
    assert.equal(rows.length, beforeCount, '迁移后行数必须与迁移前一致（不许丢工单）');
    // body 为空：content 只有 title，末尾不留空行
    assert.equal(rows[0].content, '只有标题', 'body 为空时 content 就是 title');
    // body 非空：title 与 body 之间空一行（契约 1.3）
    assert.equal(rows[1].content, '标题\n\n正文第一行\n第二行', 'content = title + 空行 + body，body 内部换行原样保留');
    // 其余列逐行搬过去，不能被重建流程弄丢
    assert.equal(rows[1].status, 'in_progress');
    assert.equal(rows[1].priority, 2);
    assert.equal(rows[1].blocked_by, 'demo#1');
    assert.equal(rows[1].actor_id, 'ai');
    assert.equal(rows[1].actor_role, 'ai');
    assert.equal(rows[1].model, 'deepseek-v4.1');

    // 索引必须重建，否则看板排序与 seq 唯一性直接失效
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tickets' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    for (const name of ['tickets_ws_seq', 'tickets_ws_status', 'tickets_ws_updated']) {
      assert.ok(indexes.includes(name), `迁移后必须重建索引 ${name}，实际 ${JSON.stringify(indexes)}`);
    }

    // 评论跟着工单一起活着
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1, '评论不能被迁移连坐删掉');
    db.close();

    // 再开一次：迁移必须幂等，不能把 content 又拼一遍
    db = openDb(dbPath);
    const again = db.prepare('SELECT content FROM tickets WHERE id = ?').get('t2');
    assert.equal(again.content, '标题\n\n正文第一行\n第二行', '重复打开不得二次拼接 content');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
