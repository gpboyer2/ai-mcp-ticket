// SQLite 连接 + 建表 + 迁移。
// 为什么用 user_version 而不是每次去比对 sqlite_master：表结构会随需求演进，
// 版本号只需一条 pragma 就能判断"该跑哪几步迁移"，重复启动也不会重复执行。
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DB_PATH = path.join(ROOT, 'data', 'ticket.db');
export const SCHEMA_VERSION = 2;

// 认领（锁定）惰性过期时长（契约 1.6 / 3.2.1）。
// ⚠️ 契约自相矛盾：1.6 正文第 5 条写「30 分钟」，但 1.6 数据模型注释、3.2.1 都写「6 小时（CLAIM_STALE_MS）」。
// 这里取 6 小时作为单一常量默认值（与命名常量 CLAIM_STALE_MS 对齐、且被「可调常量」描述过两次），
// 30 分钟/6 小时的最终取值待 lead / 用户拍板。改这一行即可全局调整。
export const CLAIM_STALE_MS = 6 * 60 * 60 * 1000;

/** DB_PATH 环境变量 / 显式参数 / 默认 data/ticket.db */
export function resolveDbPath(dbPath) {
  const raw = dbPath || process.env.DB_PATH || DEFAULT_DB_PATH;
  return raw === ':memory:' ? raw : path.resolve(raw);
}

// 建表语句：全部 IF NOT EXISTS，保证重复启动不炸
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,              -- DSH 的 workspace UUID，稳定不重复
  slug       TEXT NOT NULL UNIQUE,          -- 友好 URL 用，生成后不再改（ref 依赖它）
  title      TEXT NOT NULL,
  path       TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0,    -- DSH 里删掉的工作区只标记不删除（可能有工单挂靠）
  synced_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_seq (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  next_seq     INTEGER NOT NULL DEFAULT 1   -- 序号不回收，所以用独立计数器而不是 MAX(seq)+1
);

CREATE TABLE IF NOT EXISTS tickets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','reopened','done','cancelled')),
  priority     INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
  position     REAL NOT NULL,
  blocked_by   TEXT NOT NULL DEFAULT '',
  actor_id     TEXT NOT NULL,
  actor_role   TEXT NOT NULL CHECK (actor_role IN ('user','ai')),
  model        TEXT,
  assignee_id     TEXT,                       -- 认领者 id（NULL = 未认领）
  assignee_role   TEXT CHECK (assignee_role IN ('user','ai')),  -- 认领者角色
  assignee_model  TEXT,                       -- 认领者模型（user 为 NULL）
  claimed_at      TEXT,                        -- 认领时间 ISO8601 UTC
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user','ai')),
  model      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id            TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user','ai')),
  model         TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tickets_ws_seq      ON tickets(workspace_id, seq);
CREATE INDEX        IF NOT EXISTS tickets_ws_status   ON tickets(workspace_id, status, position);
CREATE INDEX        IF NOT EXISTS tickets_ws_updated  ON tickets(workspace_id, updated_at);
CREATE INDEX        IF NOT EXISTS comments_ticket     ON comments(ticket_id, created_at);
-- model 可为 NULL，唯一性要用表达式索引把 NULL 归一，否则同一 actor 会重复登记
CREATE UNIQUE INDEX IF NOT EXISTS actors_uniq         ON actors(id, role, COALESCE(model, ''));
`;

/** 幂等加列：已存在的库用 ALTER 增量加，绝不 DROP 重建（用户库有真实工单，丢了不可恢复） */
function addColumnIfMissing(db, table, col, def) {
  const cols = db.pragma(`table_info(${table})`);
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

function migrate(db) {
  const from = db.pragma('user_version', { simple: true });
  if (from >= SCHEMA_VERSION) return from;

  db.transaction(() => {
    db.exec(SCHEMA);
    // 1 → 2：tickets 表加认领四列（已存在库走 ALTER，全新库 CREATE TABLE 已含）
    if (from < 2) {
      addColumnIfMissing(db, 'tickets', 'assignee_id', 'TEXT');
      addColumnIfMissing(db, 'tickets', 'assignee_role', "TEXT CHECK (assignee_role IN ('user','ai'))");
      addColumnIfMissing(db, 'tickets', 'assignee_model', 'TEXT');
      addColumnIfMissing(db, 'tickets', 'claimed_at', 'TEXT');
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();

  return SCHEMA_VERSION;
}

/** 打开（必要时创建）数据库，返回 better-sqlite3 实例 */
export function openDb(dbPath) {
  const file = resolveDbPath(dbPath);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  // WAL：读写并发不互斥；busy_timeout：多进程（MCP 并发请求）撞锁时等 5 秒而不是直接报错
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

// 进程内单调时钟。
// 为什么必须单调：AI 靠工单 updated_at 判断「有没有新动静」。系统时钟精度是毫秒，
// 建单和加评论常落在同一毫秒，两者拿到相同时间戳，AI 就会认为工单没变过。
// 做法：记住上一次返回值，若本次 Date.now() 不大于它，就在上一次基础上 +1ms。
// 注意：只有"写入时生成时间戳"走这里；从库里读出的历史值原样返回，不会被改写。
let lastMono = 0;
export function nowIso() {
  const now = Date.now();
  lastMono = now > lastMono ? now : lastMono + 1;
  return new Date(lastMono).toISOString();
}

export const newId = () => randomUUID();
