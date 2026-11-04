// 内容协商（契约 4 节开头）：同一批 URL 按 Accept / 后缀 / format 决定 HTML 还是 text/plain。
// 为什么这条重要：AI 的 fetch 常常只带 Accept: text/plain，拿不到纯文本它就得啃 HTML，token 直接翻十倍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, reqText, startTestApp } from './_helpers.js';

const WS = 'demo-project';

test('同一 URL：Accept: text/plain → text/plain；默认 → text/html', async () => {
  const app = await startTestApp();
  try {
    // 根路径
    const rootText = await reqText(app.base, '/', { Accept: 'text/plain' });
    assert.equal(rootText.status, 200);
    assert.match(rootText.contentType, /^text\/plain; charset=utf-8/, 'Accept: text/plain 必须返回 text/plain');
    assert.ok(rootText.text.startsWith('# ai-mcp-ticket'), '返回的必须是纯文本视图而不是 HTML');
    assert.equal(rootText.vary.toLowerCase(), 'accept', '纯文本响应必须带 Vary: Accept（契约 4 节）');

    const rootHtml = await reqText(app.base, '/');
    assert.equal(rootHtml.status, 200);
    assert.match(rootHtml.contentType, /^text\/html; charset=utf-8/, '不带 Accept 时默认返回 HTML');
    assert.match(rootHtml.text, /<!DOCTYPE html>/i, 'HTML 形态应是前端外壳');

    // 列表页
    const listText = await reqText(app.base, `/${WS}/list`, { Accept: 'text/plain' });
    assert.match(listText.contentType, /^text\/plain/, '/{ws}/list + Accept: text/plain → 纯文本');
    assert.ok(listText.text.includes('# ai-mcp-ticket  workspace:'));
    const listHtml = await reqText(app.base, `/${WS}/list`);
    assert.match(listHtml.contentType, /^text\/html/, '/{ws}/list 默认 → HTML（前端看板）');

    // 单张工单：先建一张
    const t = (
      await req(app.base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: { content: '协商测试' } })
    ).body;
    const oneText = await reqText(app.base, `/${WS}/t/${t.seq}`, { Accept: 'text/plain' });
    assert.match(oneText.contentType, /^text\/plain/);
    assert.ok(oneText.text.startsWith(`# ai-mcp-ticket ticket: ${WS}#${t.seq}`));
    const oneHtml = await reqText(app.base, `/${WS}/t/${t.seq}`);
    assert.match(oneHtml.contentType, /^text\/html/);
  } finally {
    await app.close();
  }
});

test('.txt 后缀 / ?format=text / ?format=txt 都强制纯文本（即使 Accept 要 HTML）', async () => {
  const app = await startTestApp();
  try {
    const t = (
      await req(app.base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: { content: '后缀测试' } })
    ).body;

    // 明确带 Accept: text/html，验证"后缀优先于 Accept"
    const htmlAccept = { Accept: 'text/html,application/xhtml+xml' };

    const suffixList = await reqText(app.base, `/${WS}/list.txt`, htmlAccept);
    assert.match(suffixList.contentType, /^text\/plain/, '契约 4.1 示例就是 /{ws}/list.txt，必须返回纯文本');
    assert.ok(suffixList.text.includes('# ai-mcp-ticket  workspace:'));

    const suffixOne = await reqText(app.base, `/${WS}/t/${t.seq}.txt`, htmlAccept);
    assert.match(suffixOne.contentType, /^text\/plain/, '/{ws}/t/{seq}.txt 必须返回纯文本');
    assert.ok(suffixOne.text.startsWith(`# ai-mcp-ticket ticket: ${WS}#${t.seq}`));

    const fmtText = await reqText(app.base, `/${WS}/list?format=text`, htmlAccept);
    assert.match(fmtText.contentType, /^text\/plain/, '?format=text 必须强制纯文本');

    const fmtTxt = await reqText(app.base, `/${WS}/list?format=txt`, htmlAccept);
    assert.match(fmtTxt.contentType, /^text\/plain/, '?format=txt 与 format=text 等价');

    const fmtUpper = await reqText(app.base, `/${WS}/list?format=TEXT`, htmlAccept);
    assert.match(fmtUpper.contentType, /^text\/plain/, 'format 值应大小写不敏感');

    // 根路径的 ?format=text
    const rootFmt = await reqText(app.base, '/?format=text', htmlAccept);
    assert.match(rootFmt.contentType, /^text\/plain/, '根路径也要支持 ?format=text');
  } finally {
    await app.close();
  }
});

test('Accept 顺序决定：text/plain 在前 → 纯文本；text/html 在前 → HTML', async () => {
  const app = await startTestApp();
  try {
    const plainFirst = await reqText(app.base, `/${WS}/list`, { Accept: 'text/plain, text/html;q=0.9' });
    assert.match(plainFirst.contentType, /^text\/plain/, 'text/plain 排前面时必须给纯文本');

    const htmlFirst = await reqText(app.base, `/${WS}/list`, { Accept: 'text/html, text/plain;q=0.9' });
    assert.match(htmlFirst.contentType, /^text\/html/, 'text/html 排前面时必须给 HTML');

    // 只接受 text/plain（AI 常见写法）
    const onlyPlain = await reqText(app.base, `/${WS}/list`, { Accept: 'text/plain' });
    assert.match(onlyPlain.contentType, /^text\/plain/);

    // 只接受 */* 或 application/json → 走 HTML（默认）
    const star = await reqText(app.base, `/${WS}/list`, { Accept: '*/*' });
    assert.match(star.contentType, /^text\/html/, 'Accept: */* 时默认给 HTML（浏览器行为）');

    // 完全不带 Accept
    const noAccept = await fetch(app.base + `/${WS}/list`);
    assert.match(noAccept.headers.get('content-type') || '', /^text\/html/, '没有 Accept 头时默认 HTML');
  } finally {
    await app.close();
  }
});

test('/api/workspaces/:ws/text 一定返回纯文本（给 MCP / 脚本用，不看 Accept）', async () => {
  const app = await startTestApp();
  try {
    await req(app.base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: { content: 'API text' } });
    // 带一个明确要 JSON 的 Accept，仍然必须给纯文本
    const r = await reqText(app.base, `/api/workspaces/${WS}/text`, { Accept: 'application/json' });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^text\/plain/, '契约 4.1：这个端点"保证一定返回 text"');
    assert.ok(r.text.startsWith(`# ai-mcp-ticket  workspace: ${WS}`), '内容必须是 4.2 格式的列表');
    assert.ok(r.text.includes('content: API text'));

    // 支持 status / maxlen / comments 参数
    const filtered = await reqText(app.base, `/api/workspaces/${WS}/text?status=done`);
    assert.ok(filtered.text.includes('count: 0'), 'status=done 时该工作区还没有 done 工单');
  } finally {
    await app.close();
  }
});

test('纯文本 404 也是 text/plain（AI 读不了 HTML 错误页）', async () => {
  const app = await startTestApp();
  try {
    const noWs = await reqText(app.base, '/nope/list', { Accept: 'text/plain' });
    assert.equal(noWs.status, 404, '不存在的工作区必须 404');
    assert.match(noWs.contentType, /^text\/plain/, '纯文本请求的 404 也必须返回 text/plain');
    assert.ok(noWs.text.includes('404'), '纯文本 404 正文要说明是 404');

    const noTicket = await reqText(app.base, `/${WS}/t/999`, { Accept: 'text/plain' });
    assert.equal(noTicket.status, 404);
    assert.match(noTicket.contentType, /^text\/plain/);

    // HTML 请求的 404 走 JSON 错误体（契约 3 的统一错误格式）
    const htmlReq = await req(app.base, '/nope/list');
    assert.equal(htmlReq.status, 404);
    assert.equal(htmlReq.body.error.code, 'WORKSPACE_NOT_FOUND', 'HTML 请求的 404 应是 JSON 错误体');
  } finally {
    await app.close();
  }
});

test('健康检查 /healthz 返回契约 0 约定的字段', async () => {
  const app = await startTestApp();
  try {
    const h = await req(app.base, '/healthz');
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true, 'ok 必须是 true');
    assert.equal(typeof h.body.version, 'string', '必须带 version');
    assert.equal(typeof h.body.db, 'string', '必须带 db 路径');
    assert.equal(typeof h.body.uptime, 'number', '必须带 uptime（数字）');
    assert.ok(h.body.uptime >= 0);
  } finally {
    await app.close();
  }
});
