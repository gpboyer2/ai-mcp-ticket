// MCP server（契约第 5 节）。核心取舍：所有工具返回纯文本，AI 拿到的就是第 4 节那套格式。
// 无状态：每个 POST /mcp 请求新建 server + transport，请求结束即释放（sessionIdGenerator: undefined）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { actorFromArgs, HttpError } from './actor.js';
import { renderCommentList, renderWorkspaceIndex, DEFAULT_MAXLEN } from './render/text.js';
import { listTextView, ticketTextView, baseUrlOf } from './views.js';
import { STATUSES } from './repo/workspaces.js';

const ok = (text) => ({ content: [{ type: 'text', text }] });
// 工具内部错误一律包成 isError 结果，不让异常冒到 JSON-RPC 层（否则 AI 只看到 "Internal error"）
const fail = (e) => ({
  content: [{ type: 'text', text: `错误: ${e instanceof HttpError ? e.message : e?.message || String(e)}` }],
  isError: true,
});

const STATUS_ENUM = z.enum(STATUSES);
const actorFields = {
  actor_id: z
    .string()
    .min(1)
    .describe('你自己的身份标识，必填。填你自己的名字，例如 dsh-lead、deepseek'),
  actor_model: z
    .string()
    .min(1)
    .describe('你当前正在使用的模型名，必填。例如 group/cherish-ai、deepseek-v4.1'),
};

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildMcpServer(ctx, { baseUrl = '' } = {}) {
  const { workspaces, tickets, comments, actors } = ctx;
  const server = new McpServer({ name: 'ticket', version: '1.0.0' });

  const requireWs = (ws) => {
    const row = workspaces.find(ws);
    if (!row) throw new HttpError(404, 'WORKSPACE_NOT_FOUND', `工作区不存在: ${ws}`);
    return row;
  };

  const renderList = (ws, args = {}) =>
    listTextView(ctx, ws, {
      ...args,
      maxlen: args.maxlen === undefined ? DEFAULT_MAXLEN : args.maxlen,
    }, { baseUrl });

  const renderOne = (idOrRef, writeEvent) => {
    const t = tickets.findByIdOrRef(idOrRef);
    if (!t) throw new HttpError(404, 'TICKET_NOT_FOUND', `工单不存在: ${idOrRef}`);
    return ticketTextView(ctx, workspaces.find(t.workspace_id), t, { writeEvent, baseUrl });
  };

  // 写工具：actor 固定 role=ai，参数里必须自带 id/model
  const writer = (args) => {
    const actor = actorFromArgs(args);
    actors.touch(actor);
    return actor;
  };

  server.registerTool(
    'workspace_list',
    {
      title: '工作区列表',
      description:
        '列出所有工作区（含各状态工单数）。返回纯文本。工作区只读镜像自 DeepSeek Harness，不能在这里增删。',
      inputSchema: { include_archived: z.boolean().optional().describe('是否包含已归档工作区') },
      annotations: READ,
    },
    async ({ include_archived }) => {
      try {
        return ok(
          renderWorkspaceIndex({
            workspaces: workspaces.list({ includeArchived: !!include_archived }),
            baseUrl,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ticket_list',
    {
      title: '工单列表',
      description:
        '列某工作区的工单（纯文本，含评论）。用 workspace 的 slug 或 id。想看全部状态就别传 status。',
      inputSchema: {
        workspace: z.string().min(1).describe('工作区 slug 或 id，例如 ppll-auto-trading'),
        status: z
          .string()
          .optional()
          .describe('状态过滤，逗号分隔，可选值: open,in_progress,reopened,done,cancelled'),
        q: z.string().optional().describe('在工单内容里模糊搜索'),
        maxlen: z.number().int().min(0).optional().describe(`内容截断字数，默认 ${DEFAULT_MAXLEN}，0 表示不截断`),
        comments: z.number().int().min(0).optional().describe('只显示最后 N 条评论，0 表示不显示，默认全部'),
      },
      annotations: READ,
    },
    async (args) => {
      try {
        return ok(renderList(requireWs(args.workspace), args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ticket_get',
    {
      title: '工单详情',
      description: '按 ref（如 ppll-auto-trading#12）或 uuid 取单张工单全文（含全部评论），返回纯文本。',
      inputSchema: { ref: z.string().min(1).describe('工单引用，形如 {slug}#{seq}，或 uuid') },
      annotations: READ,
    },
    async ({ ref }) => {
      try {
        return ok(renderOne(ref));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ticket_create',
    {
      title: '新建工单',
      description:
        '新建工单，返回新工单的纯文本。工单只有 content 一个内容字段（不再区分标题和正文）。' +
        'actor_id/actor_model 必填：填你自己的身份和模型，例如 dsh-lead / group/cherish-ai。',
      inputSchema: {
        workspace: z.string().min(1).describe('工作区 slug 或 id'),
        content: z.string().min(1).max(100000).describe('工单内容，Markdown 文本，1..100000 字'),
        status: STATUS_ENUM.optional().describe('默认 open'),
        priority: z.number().int().min(0).max(3).optional().describe('0=低 1=普通 2=高 3=紧急，默认 1'),
        blocked_by: z.string().optional().describe('逗号分隔的 ref 列表，表示依赖'),
        ...actorFields,
      },
      annotations: WRITE,
    },
    async (args) => {
      try {
        const actor = writer(args);
        const ws = requireWs(args.workspace);
        const t = tickets.create(ws, args, actor);
        return ok(renderOne(t.id, { event: 'ticket_create', actorRole: actor.role }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ticket_update',
    {
      title: '更新工单',
      description:
        '局部更新工单（只传要改的字段），返回更新后的纯文本。' +
        '处理完务必把 status 推进到 in_progress / done；状态不是装饰，用户靠它看看板。' +
        'actor_id/actor_model 必填：填你自己的身份和模型。',
      inputSchema: {
        ref: z.string().min(1).describe('工单引用，形如 {slug}#{seq}，或 uuid'),
        content: z.string().max(100000).optional().describe('新的工单内容'),
        status: STATUS_ENUM.optional().describe('改状态时 position 会自动落到目标列末尾'),
        priority: z.number().int().min(0).max(3).optional(),
        blocked_by: z.string().optional(),
        position: z.number().optional().describe('同列排序位置，越小越靠前；拖拽换列时传'),
        ...actorFields,
      },
      annotations: WRITE,
    },
    async (args) => {
      try {
        const actor = writer(args);
        const t = tickets.update(args.ref, args, actor);
        return ok(renderOne(t.id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ticket_delete',
    {
      title: '删除工单',
      description:
        '删除工单（连同它的评论），返回 deleted: ref。actor_id/actor_model 必填：填你自己的身份和模型。',
      inputSchema: {
        ref: z.string().min(1).describe('工单引用，形如 {slug}#{seq}，或 uuid'),
        ...actorFields,
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async (args) => {
      try {
        writer(args);
        const { ref } = tickets.remove(args.ref);
        return ok(`deleted: ${ref}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'comment_list',
    {
      title: '评论列表',
      description: '列某工单的全部评论（按时间升序），返回纯文本。',
      inputSchema: { ref: z.string().min(1).describe('工单引用，形如 {slug}#{seq}，或 uuid') },
      annotations: READ,
    },
    async ({ ref }) => {
      try {
        const t = tickets.findByIdOrRef(ref);
        if (!t) throw new HttpError(404, 'TICKET_NOT_FOUND', `工单不存在: ${ref}`);
        return ok(renderCommentList(t, comments.list(t.id)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'comment_add',
    {
      title: '添加评论',
      description:
        '给工单加一条评论，返回该工单最新全文（含新评论）。' +
        '处理完务必把 status 推进到 in_progress / done；状态不是装饰，用户靠它看看板。' +
        'actor_id/actor_model 必填：填你自己的身份和模型。',
      inputSchema: {
        ref: z.string().min(1).describe('工单引用，形如 {slug}#{seq}，或 uuid'),
        body: z.string().min(1).max(10000).describe('评论正文，1..10000 字'),
        ...actorFields,
      },
      annotations: WRITE,
    },
    async (args) => {
      try {
        const actor = writer(args);
        const t = tickets.findByIdOrRef(args.ref);
        if (!t) throw new HttpError(404, 'TICKET_NOT_FOUND', `工单不存在: ${args.ref}`);
        comments.create(t.id, { body: args.body }, actor);
        return ok(renderOne(t.id, { event: 'comment_add', body: args.body, actorRole: actor.role }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'comment_update',
    {
      title: '修改评论',
      description:
        '改评论正文，返回该工单最新全文。actor_id/actor_model 必填：填你自己的身份和模型。',
      inputSchema: {
        comment_id: z.string().min(1).describe('评论 uuid'),
        body: z.string().min(1).max(10000).describe('新的评论正文'),
        ...actorFields,
      },
      annotations: WRITE,
    },
    async (args) => {
      try {
        const actor = writer(args);
        const c = comments.update(args.comment_id, { body: args.body });
        return ok(renderOne(c.ticket_id, { event: 'comment_add', body: args.body, actorRole: actor.role }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'comment_delete',
    {
      title: '删除评论',
      description: '删除评论，返回该工单最新全文。actor_id/actor_model 必填：填你自己的身份和模型。',
      inputSchema: {
        comment_id: z.string().min(1).describe('评论 uuid'),
        ...actorFields,
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async (args) => {
      try {
        writer(args);
        const { ticket_id: ticketId } = comments.remove(args.comment_id);
        return ok(renderOne(ticketId));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

/** POST /mcp：每请求一套 server+transport（无状态） */
export function createMcpPostHandler(ctx) {
  return async (req, res) => {
    // MCP 是无状态的（每请求新建 server），所以能拿到本次请求的 Host：
    // AI 通过局域网 IP 连过来时，文本里给的 URL 也就是那个 IP。
    const server = buildMcpServer(ctx, { baseUrl: baseUrlOf(req) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      // 传入已解析的 body：express.json() 已经读过流，不传的话 transport 拿不到
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] 处理失败:', e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `MCP 内部错误: ${e.message}` },
          id: null,
        });
      }
    }
  };
}
