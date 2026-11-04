// 中文工作区 slug 的纯文本 URL（Lead 专项验收）。
// 为什么单列一个文件：本项目的立身之本是"AI 贴一个 URL 就能读到纯文本"，
// 而真实工作区里就有 `ai-剧本` 这种中文 slug。中文 slug 在 URL 里要过
// 「浏览器/curl 编码 → Express 解码 → 路由参数 → 数据库 slug 比对」四道关，
// 任何一道把中文吃掉，AI 拿到的就是 404 或 HTML。
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, reqText, startTestApp } from './_helpers.js';

const CN_SLUG = 'ai-剧本';
// 用 /tmp 下的中文目录名：既能覆盖「中文 + 空格」，又不绑定任何人的本机路径。
const CN_DIR = '/tmp/AI 剧本';

test('中文 slug：未编码、URL 编码、.txt 后缀、?format=text 四种写法都能拿到纯文本', async () => {
  const app = await startTestApp({
    workspaces: {
      'ws-cn': { path: CN_DIR, title: 'AI 剧本' },
      'ws-ascii': { path: '/tmp/demo-project', title: 'demo-project' },
    },
  });
  try {
    // 先确认 slug 真的按契约由 basename 生成且保留了中文
    const list = (await req(app.base, '/api/workspaces')).body;
    const cn = list.find((w) => w.id === 'ws-cn');
    assert.equal(cn.slug, CN_SLUG, `中文目录名应生成中文 slug，实际 ${cn.slug}`);
    assert.equal(cn.path, CN_DIR);

    // 造一张工单，确保列表非空（空列表也返回 200，但断言内容更有说服力）
    const t = (
      await req(app.base, `/api/workspaces/${encodeURIComponent(CN_SLUG)}/tickets`, {
        method: 'POST',
        body: { title: '中文 slug 下的工单' },
      })
    ).body;
    assert.equal(t.ref, `${CN_SLUG}#1`, 'ref 里必须带中文 slug');

    const encoded = encodeURIComponent(CN_SLUG); // %E5%89%A7%E6%9C%AC 形态

    // 1) 未编码 + .txt（curl 默认会自己编码，这里测"服务器解码后能对上"）
    const rawTxt = await reqText(app.base, `/${CN_SLUG}/list.txt`, { Accept: 'text/plain' });
    assert.equal(rawTxt.status, 200, '未编码中文 slug + .txt 必须 200');
    assert.match(rawTxt.contentType, /^text\/plain; charset=utf-8/, '必须是 text/plain');
    assert.ok(rawTxt.text.startsWith(`# ai-mcp-ticket  workspace: ${CN_SLUG}  path: ${CN_DIR}`), '首行必须回显中文 slug 与含空格的中文路径');
    assert.ok(rawTxt.text.includes('    title: 中文 slug 下的工单'), '列表内容必须正确');

    // 2) 编码后 + .txt
    const encTxt = await reqText(app.base, `/${encoded}/list.txt`, { Accept: 'text/plain' });
    assert.equal(encTxt.status, 200, '编码后的中文 slug 必须 200');
    assert.equal(encTxt.text.split('\n')[0], rawTxt.text.split('\n')[0], '编码与未编码必须得到同一份内容');

    // 3) 编码后 + Accept: text/plain（AI 最常用的取法）
    const encAccept = await reqText(app.base, `/${encoded}/list`, { Accept: 'text/plain' });
    assert.equal(encAccept.status, 200);
    assert.match(encAccept.contentType, /^text\/plain/, 'Accept: text/plain 必须压过默认 HTML');
    assert.ok(encAccept.text.startsWith('# ai-mcp-ticket  workspace:'), '必须给纯文本而不是 HTML 外壳');

    // 4) 编码后 + ?format=text（不带 Accept）
    const encFormat = await reqText(app.base, `/${encoded}/list?format=text`);
    assert.equal(encFormat.status, 200);
    assert.match(encFormat.contentType, /^text\/plain/, '?format=text 必须强制纯文本');
    assert.ok(!encFormat.text.includes('<!DOCTYPE'), '不能返回 HTML');

    // 5) /api/workspaces/:ws/text —— 契约 4.1 说"保证一定返回 text"
    for (const ws of [CN_SLUG, encoded]) {
      const apiText = await reqText(app.base, `/api/workspaces/${ws}/text`, { Accept: 'application/json' });
      assert.equal(apiText.status, 200, `/api/workspaces/${ws}/text 必须 200`);
      assert.match(apiText.contentType, /^text\/plain/, '必须返回 text/plain（即使 Accept 要 JSON）');
      assert.ok(apiText.text.startsWith(`# ai-mcp-ticket  workspace: ${CN_SLUG}`));
    }

    // 6) 单工单纯文本：/{中文slug}/t/{seq}.txt
    for (const ws of [CN_SLUG, encoded]) {
      const one = await reqText(app.base, `/${ws}/t/${t.seq}.txt`, { Accept: 'text/plain' });
      assert.equal(one.status, 200, `/${ws}/t/${t.seq}.txt 必须 200`);
      assert.ok(one.text.startsWith(`# ai-mcp-ticket ticket: ${CN_SLUG}#${t.seq}`), '首行必须带中文 ref');
      assert.ok(one.text.includes(`path: ${CN_DIR}`), '必须带中文路径');
    }

    // 7) 根索引纯文本里也要能看到中文工作区
    const root = await reqText(app.base, '/', { Accept: 'text/plain' });
    assert.ok(root.text.includes(CN_SLUG), '工作区索引必须列出中文 slug');
    assert.ok(root.text.includes(CN_DIR), '工作区索引必须列出中文路径');
    // 契约 4.2 改版：索引里的 list 行给完整 URL（带 host），AI 拿到就能直接 fetch
    assert.match(
      root.text,
      new RegExp(`    list: https?://[^/]+/${CN_SLUG}/list\\.txt`),
      '索引里给出的 list URL 必须是带 host 的完整地址，且能直接拿去用',
    );

    // 8) MCP 侧用中文 slug 也要能查到
    const mcpRes = await fetch(app.base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ticket_list', arguments: { workspace: CN_SLUG } },
      }),
    });
    const mcpJson = await mcpRes.json();
    assert.ok(!mcpJson.result.isError, `MCP ticket_list 用中文 slug 不应报错: ${mcpJson.result?.content?.[0]?.text}`);
    assert.ok(mcpJson.result.content[0].text.startsWith(`# ai-mcp-ticket  workspace: ${CN_SLUG}`), 'MCP 也必须认中文 slug');
  } finally {
    await app.close();
  }
});

test('中文 slug 的边界：含空格目录、含特殊字符目录、编码错误都不崩', async () => {
  const app = await startTestApp({
    workspaces: {
      'ws-1': { path: '/tmp/我的 项目', title: '带空格的中文目录' },
      'ws-2': { path: '/tmp/a&b=c', title: '特殊字符' },
    },
  });
  try {
    const list = (await req(app.base, '/api/workspaces')).body;
    const spaced = list.find((w) => w.id === 'ws-1');
    // 空格会被 slugify 转成 '-'（契约 1.2：空格转 -）
    assert.equal(spaced.slug, '我的-项目', `含空格的中文目录应转成 我的-项目，实际 ${spaced.slug}`);
    const special = list.find((w) => w.id === 'ws-2');
    assert.equal(special.slug, 'abc', `& 与 = 应被剔除，实际 ${special.slug}`);

    // 两种 slug 都要能用纯文本访问
    for (const slug of ['我的-项目', encodeURIComponent('我的-项目'), 'abc']) {
      const r = await reqText(app.base, `/${slug}/list.txt`, { Accept: 'text/plain' });
      assert.equal(r.status, 200, `/${slug}/list.txt 必须 200`);
      assert.match(r.contentType, /^text\/plain/);
    }

    // 非法百分号编码不能 500（Express 解码失败时不能把进程打挂）
    const bad = await reqText(app.base, '/%E4%ZZ/list.txt', { Accept: 'text/plain' });
    assert.ok(bad.status === 400 || bad.status === 404, `畸形编码应 4xx，实际 ${bad.status}`);
    // 服务还活着
    assert.equal((await req(app.base, '/healthz')).status, 200);
  } finally {
    await app.close();
  }
});
