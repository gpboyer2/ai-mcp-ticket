#!/usr/bin/env node
/**
 * @file 查 md 里的 AI 套话：只收删掉后句子意思不变的纯填充词。
 *
 * 与注释检查器同一条思路：只审本次提交新增的行，存量不追究。
 * 词表刻意保守——宁可漏报，也不误杀「闭环」「颗粒度」这类领域里真在用的词。
 *
 * 用法：node scripts/check-md-filler.mjs [--all]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 纯填充词：删掉之后句子意思不变，任何技术文档里都没有信息量。 */
export const FILLER = [
  '综上所述', '总而言之', '总的来说', '总体而言', '总体来看',
  '值得注意的是', '需要强调的是', '需要指出的是', '值得一提的是',
  '不难发现', '众所周知', '由此可见',
  '在当今', '随着人工智能', '随着技术',
  '话不多说', '言归正传',
];

/**
 * 在一段文本的新增行里找套话。
 *
 * 代码块里的内容一律跳过：README 里的示例代码、提示词模板不该被当成散文审。
 */
export function findFiller(lines) {
  const hits = [];
  let inFence = false;
  for (const { no, text } of lines) {
    if (/^\s*(```|~~~)/.test(text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const word of FILLER) {
      let at = text.indexOf(word);
      while (at !== -1) { hits.push({ line: no, word, col: at + 1 }); at = text.indexOf(word, at + 1); }
    }
  }
  return hits;
}

/** 从 `git diff -U0` 里解出本次新增的行号和文本。 */
export function parseAddedLines(diffText) {
  const added = [];
  let no = 0;
  for (const line of diffText.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) { no = Number(m[1]); continue; }
    if (no && line.startsWith('+') && !line.startsWith('+++')) { added.push({ no, text: line.slice(1) }); no++; }
  }
  return added;
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const isMd = (file) => path.extname(file).toLowerCase() === '.md';

/** 规则文档本身要豁免：它必须在正文里列出这些词作反例，否则写规则就通不过规则。 */
export const isRuleDoc = (file) => /(^|\/)agents\/MD-WRITING\.md$/.test(file);

/** 暂存区模式：只看这次提交新增的 md 行。 */
export function checkStaged() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n').map((f) => f.trim()).filter((f) => f && isMd(f) && !isRuleDoc(f));

  const problems = [];
  for (const file of files) {
    const added = parseAddedLines(git(['diff', '--cached', '-U0', '--', file]));
    if (added.length === 0) continue;
    for (const hit of findFiller(added)) problems.push({ file, ...hit });
  }
  return { files, problems };
}

/** 全量模式：扫全仓库的 md。 */
export function checkAll(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'target', 'build', '.venv'].includes(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (isMd(entry.name) && !isRuleDoc(path.relative(root, abs))) files.push(path.relative(root, abs));
    }
  };
  walk(root);

  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    const lines = text.map((t, i) => ({ no: i + 1, text: t }));
    for (const hit of findFiller(lines)) problems.push({ file, ...hit });
  }
  return { files, problems };
}

function format(problem) {
  return `${problem.file}:${problem.line}:${problem.col}  「${problem.word}」删掉后句子意思不变，属于纯填充`;
}

function main() {
  const all = process.argv.includes('--all');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { files, problems } = all ? checkAll(root) : checkStaged();

  if (problems.length === 0) {
    const scope = all ? `全仓库 ${files.length} 个 md` : files.length === 0 ? '暂存区没有 md' : `本次暂存 ${files.length} 个 md`;
    console.log(`md 无套话：${scope}`);
    process.exit(0);
  }

  console.error(`❌ md 里有 AI 套话 ${problems.length} 处：\n`);
  for (const p of problems) console.error(`  · ${format(p)}`);
  console.error('\n规则见 docs/agents/MD-WRITING.md：删掉空话直接说事。真需要展开的，写成条目、表格或代码。');
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
