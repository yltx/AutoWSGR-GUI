/**
 * 汇总一次旧版数据迁移的执行结果。
 */

/** 仅统计本次实际处理的旧版配置项。 */
export interface LegacyMigrationSummary {
  detected: boolean;
  total: number;
  succeeded: number;
  failed: number;
  failedFiles: string[];
}

/** 创建不含迁移项的初始结果。 */
export function emptyLegacyMigrationSummary(
  detected = false,
): LegacyMigrationSummary {
  return {
    detected,
    total: 0,
    succeeded: 0,
    failed: 0,
    failedFiles: [],
  };
}

/** 合并设置、任务组和计划等多个迁移阶段的结果。 */
export function mergeLegacyMigrationSummaries(
  ...summaries: LegacyMigrationSummary[]
): LegacyMigrationSummary {
  return summaries.reduce<LegacyMigrationSummary>(
    (merged, summary) => ({
      detected: merged.detected || summary.detected,
      total: merged.total + summary.total,
      succeeded: merged.succeeded + summary.succeeded,
      failed: merged.failed + summary.failed,
      failedFiles: [
        ...merged.failedFiles,
        ...summary.failedFiles,
      ],
    }),
    emptyLegacyMigrationSummary(),
  );
}
