// pid 文件的单测：位置跟着数据库走，自测实例不会踩到真实实例的 pid 文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidFilePath, writePidFile, removePidFile } from '../src/pidfile.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mcp-ticket-pid-'));
}

test('pid 文件与数据库同目录', () => {
  assert.equal(pidFilePath('/proj/data/ticket.db'), '/proj/data/server.pid');
  const tmp = tmpDir();
  assert.equal(pidFilePath(path.join(tmp, 't.db')), path.join(tmp, 'server.pid'));
});

test(':memory: 数据库不写 pid 文件', () => {
  assert.equal(pidFilePath(':memory:'), null);
  assert.doesNotThrow(() => writePidFile(null));
  assert.doesNotThrow(() => removePidFile(null));
});

test('写入后再删除，文件确实消失', () => {
  const file = pidFilePath(path.join(tmpDir(), 't.db'));
  writePidFile(file, 4242);
  assert.equal(fs.readFileSync(file, 'utf8'), '4242');
  removePidFile(file, 4242);
  assert.equal(fs.existsSync(file), false);
});

test('pid 文件已被别的实例占据时不删', () => {
  const file = pidFilePath(path.join(tmpDir(), 't.db'));
  writePidFile(file, 111);
  removePidFile(file, 222);
  assert.equal(fs.readFileSync(file, 'utf8'), '111');
});

test('删除不存在的文件不报错', () => {
  const file = pidFilePath(path.join(tmpDir(), 't.db'));
  assert.doesNotThrow(() => removePidFile(file));
});