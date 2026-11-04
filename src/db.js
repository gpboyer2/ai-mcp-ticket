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
export const SCHEMA_VERSION = 3;

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

// tickets 表结构只写一份：全新库建表、2→3 表重建都取它，避免两处定义各改各的。
// content 是唯一内容字段（契约 1.3）：不再有 title/body，卡片预览只是 content 的第一行。
const ticketsTableDdl = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  content      TEXT NOT NULL,                 -- 内容（Markdown），1..100000 字
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
);`;

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

${ticketsTableDdl('tickets')}

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

// tickets 的三个索引单独抽出来：表重建会把旧表连索引一起删掉，改名后要原样补回。
const TICKET_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS tickets_ws_seq      ON tickets(workspace_id, seq);
CREATE INDEX        IF NOT EXISTS tickets_ws_status   ON tickets(workspace_id, status, position);
CREATE INDEX        IF NOT EXISTS tickets_ws_updated  ON tickets(workspace_id, updated_at);
`;

/** 幂等加列：已存在的库用 ALTER 增量加，绝不 DROP 重建（用户库有真实工单，丢了不可恢复） */
function addColumnIfMissing(db, table, col, def) {
  const cols = db.pragma(`table_info(${table})`);
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

/**
 * 2 → 3：tickets 从 title+body 迁到单 content（契约 1.3）。
 * 走 SQLite 官方表重建流程：建新表 → 逐行复制 → 删旧表 → 改名 → 重建索引。
 * title 是 NOT NULL，留着就必须每次写入编造一个值，那是假兼容，所以两列彻底移除。
 *
 * 调用前提：认领四列已补齐（1→2 那段先跑），外键已在事务外关闭 ——
 * 否则 DROP TABLE tickets 会对 comments 触发 ON DELETE CASCADE，评论全没。
 */
function rebuildTicketsToContent(db) {
  const before = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;

  db.exec('DROP TABLE IF EXISTS tickets_migrate'); // 上次迁移中断留下的残表
  db.exec(ticketsTableDdl('tickets_migrate'));
  // 存量回填：body 非空才拼「空行 + body」，否则只留 title。
  // 用 char(10) 而不是 '\n'，避开 SQL 字符串里的转义歧义。
  db.exec(`
    INSERT INTO tickets_migrate (id, workspace_id, seq, content, status, priority, position, blocked_by,
                                 actor_id, actor_role, model, assignee_id, assignee_role, assignee_model,
                                 claimed_at, created_at, updated_at)
    SELECT id, workspace_id, seq,
           title || CASE WHEN body <> '' THEN char(10) || char(10) || body ELSE '' END,
           status, priority, position, blocked_by,
           actor_id, actor_role, model, assignee_id, assignee_role, assignee_model,
           claimed_at, created_at, updated_at
      FROM tickets
  `);

  // 行数核对：不等就抛错，事务回滚，旧表原封不动。绝不允许静默丢用户工单。
  const after = db.prepare('SELECT COUNT(*) AS n FROM tickets_migrate').get().n;
  if (after !== before) {
    throw new Error(`tickets 迁移行数不一致：迁移前 ${before} 行，复制后 ${after} 行，已回滚`);
  }

  db.exec('DROP TABLE tickets');
  db.exec('ALTER TABLE tickets_migrate RENAME TO tickets');
  db.exec(TICKET_INDEXES);
}

function migrate(db) {
  const from = db.pragma('user_version', { simple: true });
  if (from >= SCHEMA_VERSION) return from;

  // 表重建期间必须关外键：DROP TABLE tickets 会对 comments 触发 ON DELETE CASCADE，那是真丢评论。
  // pragma 在事务内改是空操作，所以只能在开事务之前关、提交之后恢复。
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(SCHEMA);
      // 1 → 2：tickets 表加认领四列（已存在库走 ALTER，全新库 CREATE TABLE 已含）。
      // 必须排在 2→3 之前：表重建是逐列复制，新表要能拿到这四列。
      if (from < 2) {
        addColumnIfMissing(db, 'tickets', 'assignee_id', 'TEXT');
        addColumnIfMissing(db, 'tickets', 'assignee_role', "TEXT CHECK (assignee_role IN ('user','ai'))");
        addColumnIfMissing(db, 'tickets', 'assignee_model', 'TEXT');
        addColumnIfMissing(db, 'tickets', 'claimed_at', 'TEXT');
      }
      // 2 → 3：老库（from=1 或 2）走表重建；全新库（from=0）上面的 SCHEMA 已按 content 建好，不重建。
      if (from >= 1 && from < 3) rebuildTicketsToContent(db);

      // 关着外键做重建，提交前必须自己核一遍，否则悬空引用会被悄悄写进库
      const broken = db.pragma('foreign_key_check');
      if (broken.length) {
        throw new Error(`迁移后外键校验失败，已回滚：${JSON.stringify(broken)}`);
      }

      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }

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
