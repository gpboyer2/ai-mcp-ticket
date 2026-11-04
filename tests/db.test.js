// db / 建表幂等（契约 0、1.3、1.4）。
// 为什么单独测：建表跑两次不炸是"进程能反复重启"的底线，脏了就再也起不来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
          `INSERT INTO tickets (id, workspace_id, seq, title, body, status, priority, position, blocked_by,
                                actor_id, actor_role, model, created_at, updated_at)
           VALUES (?, 'w', ?, 'x', '', ?, ?, 1, '', 'user', 'user', NULL, ?, ?)`,
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
