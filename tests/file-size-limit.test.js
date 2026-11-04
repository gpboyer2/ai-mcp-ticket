// 单文件行数上限守卫：src/ 与 web/ 下每个 .js 文件都不许超过 MAX_LINES 行。
// 目的：业务代码 / 工具函数代码一旦膨胀到几百上千行，改一处要通读一片，AI 和人都会开始瞎猜。
// 这条用例就是那条报警线 —— 谁把文件写到超限，npm test 直接红，不用靠 review 时肉眼数。
//
// 受管范围（照工单口径，不自行扩大）：
//   - 目录：src/ 与 web/，递归到底，含子目录（src/repo/ src/routes/ src/render/ 一并算）。
//   - 文件：只算 .js。.css / .html / .json 一律不计入 —— 用户说的是"业务代码 / 工具函数代码"这种 JS 文件；
//     web/style.css 超长属于另一次拆分的事，不归这条用例管。
//
// 行数口径：
//   把文件当 UTF-8 文本读进来，按 '\n' 切分，数出物理行数。空行、注释行、代码行一视同仁，都算。
//   文件末尾那个换行不额外算一行，所以这里的数字与 `wc -l` 完全一致：
//   "a\n\nb\n" -> 3 行（a、空行、b），而不是 4 行。
//
// 断言失败时报告：哪个文件、实际多少行、超过多少行、超了多少行，一次列出全部超限文件，不遮遮掩掩。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** 单个受管文件的物理行数上限，调整阈值只改这一个数 */
const MAX_LINES = 700;

/** 受管目录（相对仓库根），调整范围只改这个数组 */
const MANAGED_DIRS = ['src', 'web'];

/** 受管扩展名：只有 .js 计入 */
const COUNTED_EXT = '.js';

/** 仓库根目录，靠本文件位置反推，不依赖 process.cwd()（谁在哪跑测试都指向同一处） */
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 数一段文本的物理行数：按 '\n' 切分，末尾换行不算额外一行。
 * 空文本算 0 行。
 */
function countLinesInText(text) {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** 读文件数行数 */
function countLines(file) {
  return countLinesInText(fs.readFileSync(file, 'utf8'));
}

/** 递归收集 dir 下所有受管文件（.js），返回绝对路径数组，按路径排序保证输出稳定 */
function collectManagedFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectManagedFiles(full));
    } else if (entry.isFile() && path.extname(entry.name) === COUNTED_EXT) {
      found.push(full);
    }
  }
  return found.sort();
}

test('行数口径：空行与注释计入，末尾换行不额外算一行', () => {
  assert.equal(countLinesInText(''), 0);
  assert.equal(countLinesInText('a'), 1);
  assert.equal(countLinesInText('a\n'), 1);
  assert.equal(countLinesInText('a\n\nb\n'), 3);
  // 注释行与空行都算物理行
  assert.equal(countLinesInText('// 注释\n\nconst x = 1;\n'), 3);
});

test(`受管目录能扫到 ${COUNTED_EXT} 文件（防止目录名写错导致空跑假绿）`, () => {
  const files = MANAGED_DIRS.flatMap((dir) => {
    const abs = path.join(ROOT, dir);
    assert.ok(fs.existsSync(abs), `受管目录不存在：${dir}（期望在 ${abs}）`);
    assert.ok(fs.statSync(abs).isDirectory(), `受管路径不是目录：${abs}`);
    return collectManagedFiles(abs);
  });

  assert.ok(
    files.length > 0,
    `在 ${MANAGED_DIRS.join(' / ')} 下一个 ${COUNTED_EXT} 文件都没扫到，说明遍历逻辑或受管范围写错了`,
  );
});

test(`src/ 与 web/ 下每个 ${COUNTED_EXT} 文件都不超过 ${MAX_LINES} 行`, () => {
  const overLimit = [];
  let scanned = 0;
  let largest = { file: null, lines: 0 };

  for (const dir of MANAGED_DIRS) {
    for (const file of collectManagedFiles(path.join(ROOT, dir))) {
      const lines = countLines(file);
      scanned += 1;
      const rel = path.relative(ROOT, file);
      if (lines > largest.lines) largest = { file: rel, lines };
      if (lines > MAX_LINES) {
        overLimit.push(`${rel}：实际 ${lines} 行，超过上限 ${MAX_LINES} 行，超了 ${lines - MAX_LINES} 行`);
      }
    }
  }

  assert.ok(scanned > 0, `没有扫描到任何 ${COUNTED_EXT} 文件，统计无效`);

  if (overLimit.length > 0) {
    assert.fail(
      `以下 ${overLimit.length} 个文件超过 ${MAX_LINES} 行上限，请拆分（本次最大的是 ${largest.file}，${largest.lines} 行）：\n` +
        overLimit.map((line) => `  - ${line}`).join('\n'),
    );
  }
});
