// 身份解析（契约第 2 节）。REST 和 MCP 共用同一套规则，避免两边对"谁在说话"理解不一致。
// 优先级：HTTP 头 > body.actor > query 参数。

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const USER = Object.freeze({ id: 'user', role: 'user', model: null });

function pick(req, body, query) {
  const h = req.headers || {};
  const headerId = h['x-actor-id'];
  const headerRole = h['x-actor-role'];
  const headerModel = h['x-actor-model'];
  // 头存在（哪怕空串也视为"这一层说了话"），据此决定是否下探到 body / query
  if (headerId || headerRole || headerModel) {
    return { id: headerId, role: headerRole, model: headerModel };
  }
  const a = body && typeof body === 'object' ? body.actor : undefined;
  if (a && typeof a === 'object') return { id: a.id, role: a.role, model: a.model };
  if (query && (query.actor_id || query.actor_role || query.actor_model)) {
    return { id: query.actor_id, role: query.actor_role, model: query.actor_model };
  }
  return {};
}

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * 从请求里解析出 actor。
 * @param {{headers:object}} req
 * @param {object} [body] 已解析的 JSON body
 * @param {object} [query] 查询参数
 * @returns {{id:string, role:'user'|'ai', model:string|null}}
 * @throws {HttpError} role=ai 但缺 id 或 model 时 400 ACTOR_REQUIRED
 */
export function resolveActor(req, body, query) {
  const raw = pick(req, body, query);
  const role = clean(raw.role) || 'user';

  if (role === 'user') {
    // 契约：user 身份强制归一，忽略传入的 id/model（浏览器不带任何头就是 user）
    return { ...USER };
  }
  if (role !== 'ai') {
    throw new HttpError(400, 'ACTOR_ROLE_INVALID', `role 只能是 user 或 ai，收到 "${role}"`);
  }

  const id = clean(raw.id);
  const model = clean(raw.model);
  if (!id || !model) {
    throw new HttpError(
      400,
      'ACTOR_REQUIRED',
      'role=ai 时必须同时提供 actor id 与 model',
    );
  }
  return { id, role: 'ai', model };
}

/** MCP 工具里 actor 直接来自参数，不经过 HTTP 头 */
export function actorFromArgs(args) {
  return resolveActor({ headers: {} }, { actor: { id: args.actor_id, role: 'ai', model: args.actor_model } });
}
