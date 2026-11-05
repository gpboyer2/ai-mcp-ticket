// 组装 ctx：HTTP 服务与 stdio MCP 共用这一份，避免两边各搭一套 repo。
import { openDb } from './db.js';
import { createWorkspaceRepo } from './repo/workspaces.js';
import { createTicketRepo } from './repo/tickets.js';
import { createCommentRepo } from './repo/comments.js';
import { createActorRepo } from './repo/actors.js';

export function createContext({ dbPath, dshWorkspaceFile } = {}) {
  const db = openDb(dbPath);
  const workspaces = createWorkspaceRepo(db);
  const tickets = createTicketRepo(db, workspaces);
  // 评论 repo 拿工单 repo：写评论时可能同一次提交改状态，迁移规则只能有一份（tickets.update）
  const comments = createCommentRepo(db, tickets);
  const actors = createActorRepo(db);

  return {
    db,
    workspaces,
    tickets,
    comments,
    actors,
    syncOpts: dshWorkspaceFile ? { file: dshWorkspaceFile } : {},
  };
}
