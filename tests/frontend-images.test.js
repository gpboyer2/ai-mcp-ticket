// 前端图片渲染单测：web/images.js 的 safeImgUrl / countImages。
// 为什么值得测：纯文本视图给 AI 的图片是绝对 URL（契约 3.5），AI 会把它原样贴回来写进评论。
// 前端如果只认站内相对路径，AI 写回来的图在网页上就变成一段看不见的纯文本 —— 人和 AI 看到的不一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const WEB = path.resolve(import.meta.dirname, '..', 'web');
const ORIGIN = 'http://127.0.0.1:47321';

/** 用最小 stub 加载 web/images.js，返回它挂到 window.Images 上的能力 */
function loadImages() {
  const code = fs.readFileSync(path.join(WEB, 'images.js'), 'utf8');
  const noop = () => {};
  const window = {
    location: { origin: ORIGIN, host: '127.0.0.1:47321', protocol: 'http:' },
    TT: { esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), toast: noop },
  };
  const ctx = vm.createContext({ window, document: { createElement: () => ({}) }, URL, String, Array, Math, setTimeout, clearTimeout, console });
  vm.runInContext(code, ctx, { filename: 'images.js' });
  assert.ok(ctx.window.Images, 'images.js 必须把能力挂到 window.Images 上');
  return ctx.window.Images;
}

const Images = loadImages();

test('图片地址：站内相对路径与同源绝对 URL 都能渲染，外站一律不渲染', () => {
  const html = Images.renderMarkdownImages(
    [
      '![a](/uploads/20261105-44bfeae7.png)',
      `![b](${ORIGIN}/uploads/20261105-44bfeae7.png)`,
      '![c](http://evil.example/uploads/20261105-44bfeae7.png)',
      '![d](/uploads/../../etc/passwd)',
    ].join('\n'),
  );

  assert.ok(html.includes('src="/uploads/20261105-44bfeae7.png"'), '站内相对路径要渲染成图');
  assert.equal(
    (html.match(/<img/g) || []).length,
    2,
    '同源绝对 URL 也要渲染成图（AI 会把纯文本里的绝对 URL 贴回来），外站与路径穿越不渲染',
  );
  assert.ok(!/<img[^>]+src="http:\/\/evil\.example/.test(html), '外站地址不能进 <img src>');
});

test('含图计数：相对路径与绝对 URL 都要数进去', () => {
  assert.equal(Images.countImages('![](/uploads/a.png)'), 1);
  assert.equal(Images.countImages(`![](${ORIGIN}/uploads/a.png)`), 1, 'AI 贴回来的绝对 URL 也要算');
  assert.equal(
    Images.countImages(`![](${ORIGIN}/uploads/a.png)\n![](/uploads/b.png)`),
    2,
  );
  assert.equal(Images.countImages('没有图'), 0);
});
