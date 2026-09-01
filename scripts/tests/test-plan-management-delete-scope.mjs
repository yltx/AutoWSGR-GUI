/**
 * 计划管理批量删除范围的确定性测试。
 *
 * 背景：勾选状态跨筛选条件保留（导出功能的有意设计），
 * 但批量删除是破坏性操作，范围必须限定在过滤后的可见结果内。
 *
 * 旧实现：删除时使用全部勾选（[...selections.values()]），
 *   会把被当前筛选过滤掉的舰队方案也纳入删除范围。
 * 新实现：删除范围 = 当前筛选可见 ∩ 已勾选（filterVisibleSelections）。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const result = esbuild.buildSync({
  stdin: {
    contents: [
      "export { filterVisibleSelections } from './src/view/plan/PlanManagementView.ts';",
    ].join('\n'),
    loader: 'ts',
    resolveDir: process.cwd(),
    sourcefile: 'plan-management-selection-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  loader: { '.json': 'json' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const { filterVisibleSelections } = module.exports;

/** 与 PlanManagementView.selectionKey 保持一致的大小写不敏感键。 */
const keyOf = selection =>
  `${selection.kind}:${selection.file.toLocaleLowerCase('en-US')}`;
const asMap = selections => new Map(
  selections.map(selection => [keyOf(selection), selection]),
);

const battleA = { kind: 'battle', file: 'bettle-A.yaml' };
const battleB = { kind: 'battle', file: 'bettle-B.yaml' };
const teamX = { kind: 'team', file: 'team-X.yaml' };
const teamY = { kind: 'team', file: 'team-Y.yaml' };

// ── 场景：全选后筛选「出征计划」再批量删除 ──
// 全选时无筛选，勾选了出征计划与舰队方案。
const allSelected = asMap([battleA, battleB, teamX, teamY]);

// 旧实现（修复前）：[...selections.values()] 会把被过滤的舰队方案纳入删除范围。
const legacyDeleteScope = [...allSelected.values()];
assert.ok(
  legacyDeleteScope.some(selection => selection.kind === 'team'),
  '旧实现删除范围包含被过滤掉的舰队方案（bug 复现）',
);

// 筛选「出征计划」后，当前可见只有出征计划。
const visibleSelections = [battleA, battleB];
const fixedScope = filterVisibleSelections(
  visibleSelections,
  allSelected,
  keyOf,
);
assert.deepEqual(
  fixedScope.map(selection => selection.file),
  ['bettle-A.yaml', 'bettle-B.yaml'],
  '新实现删除范围只包含当前筛选下已勾选的出征计划',
);
assert.ok(
  fixedScope.every(selection => selection.kind === 'battle'),
  '新实现不会把被过滤的舰队方案纳入删除范围',
);

// ── 未勾选的可见项不进入删除范围 ──
const partial = asMap([battleA]);
assert.deepEqual(
  filterVisibleSelections([battleA, battleB], partial, keyOf),
  [battleA],
  '未勾选的可见项不进入删除范围',
);

// ── 可见勾选为空时返回空列表 ──
assert.deepEqual(
  filterVisibleSelections([], asMap([teamX]), keyOf),
  [],
  '可见勾选为空时返回空列表',
);

// ── 文件名字母大小写不敏感：可见项与勾选键仍能匹配 ──
const caseInsensitive = filterVisibleSelections(
  [{ ...battleA, file: 'BETTLE-A.YAML' }],
  allSelected,
  keyOf,
);
assert.equal(caseInsensitive.length, 1, '大小写不敏感的文件名仍能匹配已勾选项');
assert.equal(caseInsensitive[0].file, 'BETTLE-A.YAML');

console.log('plan-management delete scope: all assertions passed');
