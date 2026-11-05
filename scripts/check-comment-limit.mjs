#!/usr/bin/env node
/**
 * @file 注释行数检查器：先在源码里认出完整注释块，再看它有没有被这次提交碰到。
 *
 * 上限：文件头 5 行、函数注释 2 行、普通注释 1 行；`@标签` 行与空行不计数。
 * 不解析语法树，只按各语言的注释符切块，所以一门语言都不用单独适配。
 *
 * 用法：node scripts/check-comment-limit.mjs [--all]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = { header: 5, function: 2, plain: 1 };

/** 参与检查的源码扩展名。加语言只改这一行。 */
export const CODE_EXTS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
  'py', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'rb', 'swift', 'scala', 'sh', 'bash', 'sql', 'lua', 'dart',
]);

/** 用 `//` 与块注释 `/* *\/` 的语言。Vue/Svelte 的 HTML 注释另算。 */
const C_STYLE = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'scala', 'dart', 'vue', 'svelte']);
/** 用 `#` 注释的语言，三引号 docstring 也算注释。 */
const HASH_STYLE = new Set(['py', 'rb', 'sh', 'bash', 'yaml', 'yml', 'toml']);
/** 用 `--` 注释的语言。 */
const DASH_STYLE = new Set(['sql', 'lua']);

/** 判断一行是不是函数/类/方法声明，决定注释能否放宽到 2 行。 */
const FUNCTION_DECL = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/,
  /^\s*(async\s+)?def\s+\w+/,
  /^\s*func\s+(\()?[^=]*\)?\s*\w+\s*\(/,
  /^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?(const\s+)?fn\s+\w+/,
  /^\s*((export|public|private|protected|internal|static|final|abstract|sealed)\s+)*(class|interface|enum|record|struct|trait|object)\s+\w+/,
  /^\s*(public|private|protected|internal|static|final|override|suspend)\b[^=;]*\(/,
  /^\s*(const|let|var)\s+[\w$]+\s*=\s*(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/,
  /^\s*(async\s+)?(get\s+|set\s+|static\s+|readonly\s+)*(#?[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(:[^{]+)?\{\s*$/,
];

/** 这些词后面跟括号是控制语句，不是函数声明。 */
const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'do', 'else',
  'with', 'try', 'finally', 'await', 'yield', 'new', 'delete', 'void', 'in', 'of',
]);

/** 这一行是不是函数/类/方法声明。 */
export function isFunctionDeclLine(line) {
  const text = line || '';
  if (!FUNCTION_DECL.some((re) => re.test(text))) return false;
  const first = text.trim().replace(/^export\s+/, '').split(/[\s(<]/)[0];
  return !CONTROL_WORDS.has(first);
}

/** 注释只许陈述代码的客观作用，不写来龙去脉、历史包袱与黑话。 */
export const WHY_WORDS = ['为什么', '原因在于', '之所以', '原因是'];

/** 黑话：同一个东西只许用规范叫法，不许另起外号。 */
export const JARGON = { 腿: '信号规则' };

/** 在一行注释正文里找内容问题。 */
export function findStyleIssues(text) {
  const issues = [];
  for (const word of WHY_WORDS) if (text.includes(word)) issues.push({ kind: 'why', word });
  for (const [bad, good] of Object.entries(JARGON)) if (text.includes(bad)) issues.push({ kind: 'jargon', word: bad, good });
  return issues;
}

/** `#` 开头的行不都是注释：C 预处理指令与 Rust 属性要排除。 */
const NOT_COMMENT_HASH = /^#\s*(\[|include\b|define\b|ifdef\b|ifndef\b|if\b|elif\b|else\b|endif\b|pragma\b|undef\b|error\b|line\b|import\b|using\b)/;

/**
 * 在整份源码里认出所有注释块，返回 [{ start, end }]（行号从 1 开始）；只做切块不做归类。
 */
export function findCommentBlocks(source, ext) {
  const blocks = [];
  const lines = source;
  const cStyle = C_STYLE.has(ext);
  const hashStyle = HASH_STYLE.has(ext);
  const dashStyle = DASH_STYLE.has(ext);

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const s = raw.trim();
    let end = -1;

    // Python 三引号 docstring：以三引号独占开头才算文档注释
    if (hashStyle && /^("""|''')/.test(s)) {
      const q = s.slice(0, 3);
      const rest = s.slice(3);
      if (rest.includes(q)) { end = i; }
      else {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes(q)) j++;
        end = Math.min(j, lines.length - 1);
      }
    }
    // HTML / Vue 注释
    else if (s.startsWith('<!--')) {
      let j = i;
      while (j < lines.length && !lines[j].includes('-->')) j++;
      end = Math.min(j, lines.length - 1);
      // 紧跟的下一行还是 HTML 注释，合进同一块（与 // 行的合并口径一致）
      while (end + 1 < lines.length && lines[end + 1].trim().startsWith('<!--')) {
        end++;
        while (end < lines.length && !lines[end].includes('-->')) end++;
      }
    }
    // 块注释 /* */
    else if (cStyle && s.startsWith('/*')) {
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) j++;
      end = Math.min(j, lines.length - 1);
    }
    // 行注释 // 或 # 或 --
    else if (
      (cStyle && s.startsWith('//')) ||
      (hashStyle && s.startsWith('#') && !NOT_COMMENT_HASH.test(s)) ||
      (dashStyle && s.startsWith('--'))
    ) {
      let j = i;
      while (j + 1 < lines.length) {
        const n = lines[j + 1].trim();
        const continues =
          (cStyle && n.startsWith('//')) ||
          (hashStyle && n.startsWith('#') && !NOT_COMMENT_HASH.test(n)) ||
          (dashStyle && n.startsWith('--'));
        if (!continues) break;
        j++;
      }
      end = j;
    }

    if (end >= 0) {
      blocks.push({ start: i + 1, end: end + 1 });
      i = end + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

/** 剥掉注释标记，返回这行的有效内容；空串表示不计数。 */
export function contentOf(line) {
  let s = line.trim();
  // 开闭分隔符单独成行时不算正文
  if (/^(\/\*+|\*+\/|<!--|-->|"""|'''|--)$/.test(s)) return '';
  if (s.startsWith('<!--')) s = s.slice(4);
  else if (s.startsWith('/*')) s = s.replace(/^\/\*+/, '');
  else if (s.startsWith('//')) s = s.replace(/^\/+/, '');
  else if (s.startsWith('--')) s = s.replace(/^-+/, '');
  else if (s.startsWith('#')) s = s.replace(/^#+/, '');
  else if (s.startsWith('"""') || s.startsWith("'''")) s = s.replace(/^("""|''')/, '');
  s = s.replace(/^\*+/, '').replace(/\*+\/$/, '').replace(/-->$/, '').replace(/("""|''')$/, '');
  s = s.trim();
  return s === '' || s.startsWith('@') ? '' : s;
}

/** 给块定性并数有效行。 */
export function classify(source, block) {
  const before = source.slice(0, block.start - 1);
  const atFileTop = before.every((l) => l.trim() === '' || l.startsWith('#!'));
  const nextLine = source[block.end] || '';
  const kind = atFileTop ? 'header' : isFunctionDeclLine(nextLine) ? 'function' : 'plain';
  const lines = source.slice(block.start - 1, block.end);
  const styleIssues = [];
  lines.forEach((raw, i) => {
    for (const issue of findStyleIssues(contentOf(raw))) {
      styleIssues.push({ ...issue, line: block.start + i, text: contentOf(raw) });
    }
  });
  return { ...block, kind, lines, styleIssues, count: lines.map(contentOf).filter((s) => s !== '').length, limit: LIMITS[kind] };
}

/** 把违规块整理成给人看的说明。 */
export function formatViolation(file, block) {
  const head = block.lines.map(contentOf).find((s) => s !== '') || '';
  const preview = head.length > 40 ? `${head.slice(0, 40)}…` : head;
  const name = { header: '文件头注释', function: '函数注释', plain: '普通注释' }[block.kind];
  return `${file}:${block.start}-${block.end}  ${name} ${block.count} 行，上限 ${block.limit} 行\n     「${preview}」`;
}

/** 把「注释写了不该写的内容」整理成说明。 */
export function formatStyle(file, issue) {
  if (issue.kind === 'jargon') {
    return `${file}:${issue.line}  黑话「${issue.word}」，改用「${issue.good}」`;
  }
  return `${file}:${issue.line}  注释在解释「${issue.word}」，改成陈述它做什么\n     「${issue.text.slice(0, 50)}」`;
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const extOf = (file) => path.extname(file).slice(1).toLowerCase();
const isCodeFile = (file) => CODE_EXTS.has(extOf(file));

/** 从 `git diff -U0` 里解出本次新增的行号集合。 */
export function parseAddedLines(diffText) {
  const added = new Set();
  let lineNo = 0;
  for (const line of diffText.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) { lineNo = Number(m[1]); continue; }
    if (lineNo && line.startsWith('+') && !line.startsWith('+++')) { added.add(lineNo); lineNo++; }
  }
  return added;
}

/** 块被这次改动碰到：块内任意一行在新增集合里。 */
export const isTouched = (block, added) => {
  for (let l = block.start; l <= block.end; l++) if (added.has(l)) return true;
  return false;
};

/** 暂存区模式：只审这次提交新增或改写的注释块。 */
export function checkStaged() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n').map((f) => f.trim()).filter((f) => f && isCodeFile(f));

  const violations = [];
  for (const file of files) {
    const added = parseAddedLines(git(['diff', '--cached', '-U0', '--', file]));
    if (added.size === 0) continue;
    let source;
    try { source = git(['show', `:${file}`]).split('\n'); } catch { continue; }
    for (const block of findCommentBlocks(source, extOf(file))) {
      if (!isTouched(block, added)) continue;
      const b = classify(source, block);
      if (b.count > b.limit) violations.push(formatViolation(file, b));
      for (const issue of b.styleIssues) violations.push(formatStyle(file, issue));
    }
  }
  return { files, violations };
}

/** 全量模式：扫全仓库，存量违规也一并报出来。 */
export function checkAll(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'target', 'build', '.venv', 'venv', '__pycache__'].includes(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (isCodeFile(entry.name)) files.push(path.relative(root, abs));
    }
  };
  walk(root);

  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    for (const block of findCommentBlocks(source, extOf(file))) {
      const b = classify(source, block);
      if (b.count > b.limit) violations.push(formatViolation(file, b));
      for (const issue of b.styleIssues) violations.push(formatStyle(file, issue));
    }
  }
  return { files, violations };
}

function main() {
  const all = process.argv.includes('--all');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { files, violations } = all ? checkAll(root) : checkStaged();

  if (violations.length === 0) {
    const scope = all ? `全仓库 ${files.length} 个源码文件` : files.length === 0 ? '暂存区没有源码文件' : `本次暂存 ${files.length} 个源码文件`;
    console.log(`注释合规：${scope}（文件头 ≤${LIMITS.header} / 函数 ≤${LIMITS.function} / 普通 ≤${LIMITS.plain}，不写为什么、不用黑话）`);
    process.exit(0);
  }

  console.error(`❌ 注释违规 ${violations.length} 处：\n`);
  for (const v of violations) console.error(`  · ${v}\n`);
  console.error('规则：文件头 ≤5 行、函数注释 ≤2 行、普通注释 ≤1 行；只陈述客观作用，不写「为什么」；不用黑话。');
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
