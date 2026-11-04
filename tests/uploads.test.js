// 契约 3.2 的 with_comments 补充 + 3.5 图片上传。
// 为什么测 with_comments：看板卡片要显示"最后一条评论摘要"，不带这个参数前端就得对每张卡再发一次
// 请求（N+1 问题），一屏 30 张卡就是 31 个请求，局域网也会明显卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { req, reqText, startTestApp } from './_helpers.js';

const WS = 'demo-project';

test('with_comments=1 附带 comments 数组；不带时不返回（省流量）', async () => {
  const app = await startTestApp();
  try {
    const t = (
      await req(app.base, `/api/workspaces/${WS}/tickets`, { method: 'POST', body: { content: '带评论' } })
    ).body;
    await req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body: { body: '第一条' } });
    await req(app.base, `/api/tickets/${t.id}/comments`, { method: 'POST', body: { body: '第二条' } });

    const without = (await req(app.base, `/api/workspaces/${WS}/tickets`)).body.tickets[0];
    assert.equal(without.comments, undefined, '不带 with_comments 时不应返回 comments（契约 3.2）');

    const withC = (await req(app.base, `/api/workspaces/${WS}/tickets?with_comments=1`)).body.tickets[0];
    assert.ok(Array.isArray(withC.comments), 'with_comments=1 必须附带 comments 数组');
    assert.equal(withC.comments.length, 2);
    assert.equal(withC.comments[0].body, '第一条');
    assert.equal(withC.comments[1].body, '第二条', '评论必须升序，最后一条才是卡片要显示的摘要');
  } finally {
    await app.close();
  }
});

test('图片上传：四种 mime 都能传，返回 {url,name,size,mime} 且能读回', async () => {
  const app = await startTestApp();
  try {
    // 最小合法 PNG（1x1 透明像素）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const cases = [
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/gif', 'gif'],
      ['image/webp', 'webp'],
    ];
    for (const [mime, ext] of cases) {
      const res = await fetch(app.base + '/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: png,
      });
      assert.equal(res.status, 201, `${mime} 上传应返回 201`);
      const body = await res.json();
      assert.match(body.name, new RegExp(`^\\d{8}-[0-9a-f]{8}\\.${ext}$`), `文件名格式应为 {{yyyyMMdd}}-{{8位hex}}.{ext}，实际 ${body.name}`);
      assert.equal(body.url, `/uploads/${body.name}`, 'url 必须能直接放进 Markdown');
      assert.equal(body.size, png.length, 'size 应是字节数');
      assert.equal(body.mime, mime);

      // 能读回，且字节完全一致（不能写坏二进制）
      const back = await fetch(app.base + body.url);
      assert.equal(back.status, 200, `${body.url} 必须能读回`);
      const buf = Buffer.from(await back.arrayBuffer());
      assert.deepEqual(buf, png, `${mime} 读回的字节必须与上传的一致`);
    }

    // 服务端生成的文件名，客户端无法指定（防穿越）—— 传一个恶意文件名也应被忽略
    const evil = await fetch(app.base + '/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Filename': '../../etc/passwd' },
      body: png,
    });
    const evilBody = await evil.json();
    assert.match(evilBody.name, /^\d{8}-[0-9a-f]{8}\.png$/, '文件名必须服务端生成，客户端输入一律忽略');
    assert.ok(!evilBody.name.includes('..'), '生成的文件名不得含 ..');
  } finally {
    await app.close();
  }
});

test('图片上传拒绝：非图片 mime → 400 UNSUPPORTED_TYPE；空 body → 400', async () => {
  const app = await startTestApp();
  try {
    for (const mime of ['text/plain', 'application/json', 'image/svg+xml', 'application/pdf']) {
      const res = await fetch(app.base + '/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: Buffer.from('x'),
      });
      assert.equal(res.status, 400, `${mime} 必须被拒（契约 3.5 只认四种图片 mime）`);
      const b = await res.json();
      assert.equal(b.error.code, 'UNSUPPORTED_TYPE', `${mime} 的错误码`);
    }

    const empty = await fetch(app.base + '/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.alloc(0),
    });
    assert.equal(empty.status, 400, '空 body 必须 400');
    assert.equal((await empty.json()).error.code, 'EMPTY_BODY');
  } finally {
    await app.close();
  }
});

test('图片上传超 10MB → 413 PAYLOAD_TOO_LARGE', async () => {
  const app = await startTestApp();
  try {
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1024, 1);
    const res = await fetch(app.base + '/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: tooBig,
    });
    assert.equal(res.status, 413, '超过 10MB 必须 413（契约 3.5）');
    const b = await res.json();
    assert.equal(b.error.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    await app.close();
  }
});

test('纯文本视图原样保留 Markdown 图片 URL（契约 3.5 末条）', async () => {
  const app = await startTestApp();
  try {
    const t = (
      await req(app.base, `/api/workspaces/${WS}/tickets`, {
        method: 'POST',
        body: { content: '带图工单\n\n截图如下 ![](/uploads/20261104-a1b2c3d4.png) 请看' },
      })
    ).body;
    const txt = await reqText(app.base, `/${WS}/t/list.txt`.replace('/list.txt', `/${t.seq}.txt`), {
      Accept: 'text/plain',
    });
    assert.ok(
      txt.text.includes('/uploads/20261104-a1b2c3d4.png'),
      'AI 读纯文本时必须能拿到图片 URL，否则它看不到图',
    );
  } finally {
    await app.close();
  }
});

test('uploads 目录落在项目 data/ 下，且被 .gitignore 忽略', async () => {
  const app = await startTestApp();
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await fetch(app.base + '/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    // 默认落盘目录是 <项目根>/data/uploads（不是 src/data/uploads —— 少退一级就会静默错位）
    // 项目根由本测试文件位置反推（tests/ 的上一级），不写死任何本机绝对路径。
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const defaultDir = path.join(projectRoot, 'data', 'uploads');
    assert.equal(fs.existsSync(defaultDir), true, `默认上传目录应是 ${defaultDir}`);
    const files = fs.readdirSync(defaultDir).filter((f) => /^\d{8}-[0-9a-f]{8}\.(png|jpg|gif|webp)$/.test(f));
    assert.ok(files.length >= 1, '上传的文件应真的落在这个目录');

    // .gitignore 必须忽略上传目录与 db 文件（否则运行时数据会进 git）
    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    assert.match(gitignore, /^data\/uploads\/?$/m, '.gitignore 必须忽略 data/uploads/');
    assert.match(gitignore, /^data\/\*\.db$/m, '.gitignore 必须忽略 data/*.db');
    assert.match(gitignore, /^node_modules\/$/m, '.gitignore 必须忽略 node_modules/');
  } finally {
    await app.close();
  }
});
