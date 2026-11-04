#!/usr/bin/env node
/**
 * 把 ai-mcp-ticket 的 MCP 端点写入 DeepSeek Harness 的 profile 补丁层。
 *
 * 为什么直接写 cordis.patch.yml：
 *   DSH 没有独立的 MCP 配置文件，一个 MCP 服务就是 @deepseek-ai/dsh-mcp-client 的一行配置，
 *   由 profile 的 patch 列表用顶层 `- insert:` 追加。Magpie 也是这么做的（见
 *   ~/Desktop/Project/magpie/internal/library/dsh.go）。
 *
 * 为什么可以不重启：
 *   desktop profile 由 Electron 启动器提供 profileContext，base 组合包会启用 @deepseek-ai/dsh-hmr，
 *   它 watch 本 profile 的 patch 文件（hmr.watchConfig），配置一改就重载插件树。
 *   若某台机器上 HMR 被禁用，改完需要重启 DSH 才生效——脚本会在结尾提示。
 *
 * 用法：
 *   node scripts/install-dsh-mcp.mjs            # 写入（幂等，已存在则更新 url）
 *   node scripts/install-dsh-mcp.mjs --remove   # 移除
 *   node scripts/install-dsh-mcp.mjs --dry-run  # 只看会写什么
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

function block(url) {
  // 缩进与 Magpie 写出来的行保持一致，方便人工阅读
  return [
    `- insert: ${MARK}`,
    `    - id: ${ROW_ID}`,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    `        serverName: "${SERVER_NAME}"`,
    '        transport: "streamable-http"',
    `        url: "${url}"`,
    '        # 服务没起时不要拦住 DSH 启动，工具稍后自动重连',
    '        failOnStartupError: false',
    '        toolCallTimeoutMs: 30000',
  ];
}

function main() {
  if (!existsSync(PATCH_PATH)) {
    console.error(`找不到 profile 补丁文件：${PATCH_PATH}`);
    console.error('先确认 DSH 已创建过该 profile，或用 DSH_PROFILE 指定别的 profile。');
    process.exit(1);
  }

  const original = readFileSync(PATCH_PATH, 'utf8');
  const lines = original.split('\n');

  // 把已有的 ai-mcp-ticket 块整段摘掉（以我们自己的 mark 开头，直到下一个顶层 "- " 或文件结束）
  const kept = [];
  let skipping = false;
  let removedCount = 0;
  for (const line of lines) {
    const isTopLevelEntry = /^- /.test(line) || line === '-';
    if (isTopLevelEntry) {
      skipping = line.includes(MARK);
      if (skipping) {
        removedCount++;
        continue;
      }
    }
    if (skipping) continue;
    kept.push(line);
  }

  let next;
  if (remove) {
    next = kept.join('\n');
  } else {
    const url = `http://127.0.0.1:${PORT}/mcp`;
    const trimmed = kept.join('\n').replace(/\n+$/, '');
    next = `${trimmed}\n${block(url).join('\n')}\n`;
  }

  // 只在真的变了才写，避免无意义的 HMR 重载
  if (next === original) {
    console.log(`[skip] ${PATCH_PATH} 已是目标状态（已移除旧块 ${removedCount} 个）`);
    return;
  }

  if (dryRun) {
    console.log('--- 将写入的差异 ---');
    console.log(remove ? `（移除 ${removedCount} 个 ${ROW_ID} 块）` : block(`http://127.0.0.1:${PORT}/mcp`).join('\n'));
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
