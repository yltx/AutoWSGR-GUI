/**
 * 构造旧版数据迁移完成后的用户提示。
 */
import * as path from 'path';
import type { LegacyMigrationSummary } from './LegacyMigrationSummary';

/** Electron 提示框所需的迁移结果文案。 */
export interface LegacyMigrationNotice {
  type: 'info' | 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
}

/** 本次没有实际迁移项时不重复打扰用户。 */
export function buildLegacyMigrationNotice(
  summary: LegacyMigrationSummary,
): LegacyMigrationNotice | null {
  if (!summary.detected || summary.total === 0) return null;

  const failedNames = summary.failedFiles
    .slice(0, 10)
    .map(file => path.basename(file));
  const hiddenFailureCount = Math.max(
    0,
    summary.failedFiles.length - failedNames.length,
  );
  const failureDetail = failedNames.length > 0
    ? [
      '',
      '失败文件：',
      ...failedNames.map(file => `- ${file}`),
      ...(hiddenFailureCount > 0
        ? [`- 另有 ${hiddenFailureCount} 个文件`]
        : []),
    ]
    : [];

  return {
    type: summary.failed > 0 ? 'warning' : 'info',
    title: '旧版数据迁移完成',
    message: [
      `当前已迁移旧版数据：${summary.total} 项`,
      `成功：${summary.succeeded} 项`,
      `失败：${summary.failed} 项`,
    ].join('\n'),
    detail: [
      '旧版原始文件均已保留。',
      '迁移失败的文件仍位于旧版本原始目录，下次启动时会继续尝试。',
      ...failureDetail,
    ].join('\n'),
    buttons: ['确定'],
  };
}
