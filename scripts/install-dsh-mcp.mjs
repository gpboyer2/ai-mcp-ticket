#!/usr/bin/env node
/**
 * 把 ai-mcp-ticket 的 MCP 配置写入 DeepSeek Harness 的 profile 补丁层（cordis.patch.yml）。
 * 默认写 stdio（客户端按需拉起子进程，跨平台）；--http 改写成 HTTP 端点；--remove 移除。
 * 用法：node scripts/install-dsh-mcp.mjs [--http|--remove|--dry-run]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePort } from '../src/port.js';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PATCH_PATH = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');

// 端口取自 src/port.js 的单一常量，不在这里另写一个数（写死过 47321，改默认值时会漂移）。
// 用 resolvePort 而不是 `Number(env.PORT || 默认)`：后者会把 PORT=0 静默变成默认端口，
// 正是本项目踩过两次的事故写法。
const PORT = resolvePort(process.env.PORT);
const SERVER_NAME = 'ticket'; // DSH 里显示成 mcp__ticket__<tool>
const ROW_ID = 'ai-mcp-ticket';
const MARK = '# ai-mcp-ticket';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const dryRun = args.includes('--dry-run');
const useHttp = args.includes('--http');

// 路径全给绝对路径：客户端的 PATH 与 cwd 跟我们这边不一定一样
const STDIO_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-stdio.js');

function block() {
  // 缩进与 Magpie 写出来的行保持一致，方便人工阅读
  const head = [
    `- insert: ${MARK}`,
    `    - id: ${ROW_ID}`,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    `        serverName: "${SERVER_NAME}"`,
  ];
  if (useHttp) {
    return head.concat([
      '        transport: "streamable-http"',
      `        url: "http://127.0.0.1:${PORT}/mcp"`,
      '        # 服务没起时不要拦住 DSH 启动，工具稍后自动重连',
      '        failOnStartupError: false',
      '        toolCallTimeoutMs: 30000',
    ]);
  }
  return head.concat([
    '        transport: "stdio"',
    `        command: "${process.execPath}"`,
    `        args: ["${STDIO_ENTRY}"]`,
    '        env:',
    `          PORT: "${PORT}"`,
  ]);
}

function main() {
  if (!existsSync(PATCH_PATH)) {
    console.error(`找不到 profile 补丁文件：${PATCH_PATH}`);
    console.error('先确认 DSH 已创建过该 profile，或用 DSH_PROFILE 指定别的 profile。');
    process.exit(1);
  }

  const original = readFileSync(PATCH_PATH, 'utf8');
  const lines = original.split('\n');

  // 按顶层条目切块（行首 "- " 起一块），把带我们 MARK 或 id 的块整段摘掉，避免 HTTP/stdio 并存导致工具重复。
  const isTopLevel = (line) => /^- /.test(line) || line === '-';
  const prefix = [];
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (isTopLevel(line)) {
      cur = [line];
      blocks.push(cur);
    } else if (cur) {
      cur.push(line);
    } else {
      prefix.push(line);
    }
  }
  const ours = (b) => b.some((l) => l.includes(MARK) || /^\s*-?\s*id:\s*ai-mcp-ticket\s*$/.test(l));
  const keptBlocks = blocks.filter((b) => !ours(b));
  const removedCount = blocks.length - keptBlocks.length;
  const kept = [...prefix, ...keptBlocks.flat()];

  let next;
  if (remove) {
    next = kept.join('\n');
  } else {
    const trimmed = kept.join('\n').replace(/\n+$/, '');
    next = `${trimmed}\n${block().join('\n')}\n`;
  }

  // 只在真的变了才写，避免无意义的 HMR 重载
  if (next === original) {
    console.log(`[skip] ${PATCH_PATH} 已是目标状态（已移除旧块 ${removedCount} 个）`);
    return;
  }

  if (dryRun) {
    console.log('--- 将写入的差异 ---');
    console.log(remove ? `（移除 ${removedCount} 个 ${ROW_ID} 块）` : block().join('\n'));
    return;
  }

  const backup = `${PATCH_PATH}.bak.before-ai-mcp-ticket-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(PATCH_PATH, backup);
  writeFileSync(PATCH_PATH, next, 'utf8');

  console.log(`[ok] 已${remove ? '移除' : '写入'} MCP 配置：${PATCH_PATH}`);
  console.log(`[ok] 备份：${backup}`);
  if (!remove) {
    console.log(`[i] DSH 里工具名形如 mcp__${SERVER_NAME}__ticket_list`);
    console.log('[i] desktop profile 的 HMR 会热加载该改动；若工具没出现，重启 DeepSeek Harness。');
  }
}

main();
