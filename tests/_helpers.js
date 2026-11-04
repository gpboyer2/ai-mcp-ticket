// 测试公共工具：每个测试文件都用自己的临时目录 + 临时 db，互不污染，跑完清理。
// 为什么不共用一份 db：node --test 默认并发跑多个文件，共用文件会互相看到对方的工单，
// 断言 count / position 这类绝对数值时必然抖动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

/** 造一个临时 workspace.json（模拟 DSH 的数据源），返回其路径 */
export function writeWorkspaceFile(dir, workspaces) {
  const file = path.join(dir, 'workspace.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ tables: { workspaces } }, null, 2),
    'utf8',
  );
  return file;
}

/**
 * 起一个只监听 127.0.0.1 随机端口的 app（不占 47321，也不碰 data/ticket.db）。
 * @param {{workspaces?:object}} [opts] workspaces: { 'ws-uuid': { path, title } }
 */
export async function startTestApp({ workspaces } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-test-'));
  const wsFile = writeWorkspaceFile(
    dir,
    workspaces || { 'ws-demo': { path: '/tmp/demo-project', title: 'demo-project' } },
  );
  const dbPath = path.join(dir, 'ticket.db');
  const inst = createApp({ dbPath, sync: false, dshWorkspaceFile: wsFile });
  const server = inst.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 首次同步：测试里显式调一次，保证工作区已入库且时序可控（不依赖定时器）
  const syncRes = await fetch(base + '/api/workspaces/sync', { method: 'POST' });

  return {
    base,
    dir,
    dbPath,
    wsFile,
    inst,
    server,
    syncRes,
    /** 关闭服务 + 关库 + 删临时目录 */
    async close() {
      await new Promise((r) => server.close(r));
      inst.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 发 JSON 请求；永远返回 {status, body, headers, text}，body 解析失败时保留原文 */
export async function req(base, urlPath, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + urlPath, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

/** 发纯文本请求，返回 {status, text, contentType, vary} */
export async function reqText(base, urlPath, headers = {}) {
  const res = await fetch(base + urlPath, { headers });
  return {
    status: res.status,
    text: await res.text(),
    contentType: res.headers.get('content-type') || '',
    vary: res.headers.get('vary') || '',
  };
}

/** AI 身份头（契约第 2 节：role=ai 必须自带 id + model） */
export const AI_HEADERS = Object.freeze({
  'X-Actor-Role': 'ai',
  'X-Actor-Id': 'dsh-lead',
  'X-Actor-Model': 'group/cherish-ai',
});

/** 一次 JSON-RPC 调用（MCP 无状态端点） */
export async function mcp(base, payload) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

/** MCP initialize，多数测试都要先握手 */
export async function mcpInit(base) {
  return mcp(base, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'node-test', version: '1' },
    },
  });
}

/** MCP tools/call 简写，返回 result 对象 */
export async function mcpCall(base, name, args, id = 2) {
  const r = await mcp(base, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return r.json.result;
}
