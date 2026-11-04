// 端口解析的纯函数单测（工单 ai-剧本#70）
//
// 为什么不真起进程测：真起进程要么绑 47321（会被正在运行的真实服务占住），
// 要么绑随机端口（那就测不出"PORT=0 会不会静默落到 47321"这个关键点）。
// 事故的本质是纯函数算错了，所以直接测纯函数最准。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePort, DEFAULT_PORT } from '../src/port.js';

test('PORT=0 必须解析成 0（系统分配随机端口），绝不能变成 47321', () => {
  // 这是事故的直接回归：0 || 47321 === 47321，用户真实服务因此被顶掉两次。
  assert.equal(resolvePort('0'), 0, 'PORT=0 被解析成了别的值 —— 会顶掉用户真实服务');
  assert.notEqual(resolvePort('0'), DEFAULT_PORT);
});

test('未设置 PORT 时用默认 47321', () => {
  assert.equal(resolvePort(undefined), DEFAULT_PORT);
  assert.equal(resolvePort(null), DEFAULT_PORT);
  assert.equal(resolvePort(''), DEFAULT_PORT);
  assert.equal(resolvePort('   '), DEFAULT_PORT);
});

test('合法端口原样返回', () => {
  assert.equal(resolvePort('47321'), 47321);
  assert.equal(resolvePort('8080'), 8080);
  assert.equal(resolvePort('65535'), 65535);
  assert.equal(resolvePort(3000), 3000); // 也接受数字
});

test('非法值抛错而不是静默降级到默认端口', () => {
  // 关键：不能悄悄 fallback 到 47321 —— 那等于把"配错了"变成"顶掉真实服务"。
  for (const bad of ['abc', '70000', '-5', '3.5', '0x10', '1e5']) {
    assert.throws(() => resolvePort(bad), /PORT 不合法/, `PORT=${bad} 应当抛错`);
  }
});
