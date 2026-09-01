/** 定义跨 Model、Controller 和 View 共用的自动出征额度规则。 */
import type { NormalFightTaskConfig } from '../types/model.js';

export const MAX_NORMAL_FIGHT_DAILY_EXECUTIONS = 999;
export const DEFAULT_NORMAL_FIGHT_DAILY_EXECUTIONS = 1;

export function normalFightDailyLimit(
  value: unknown,
  fallback = DEFAULT_NORMAL_FIGHT_DAILY_EXECUTIONS,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(
    1,
    Math.min(MAX_NORMAL_FIGHT_DAILY_EXECUTIONS, Math.trunc(parsed)),
  );
}

export function normalFightTaskKey(task: NormalFightTaskConfig): string {
  const name = task.name.trim().replace(/\\/g, '/').toLocaleLowerCase();
  const plan = task.source ? `${task.source}:${name}` : name;
  return JSON.stringify([
    plan,
    task.fleet_id ?? null,
    task.fleet_preset_index ?? null,
  ]);
}

/** 按计划和舰队去重，兼容旧配置中的重复自动出征项。 */
export function uniqueNormalFightTasks(
  tasks: readonly NormalFightTaskConfig[],
): NormalFightTaskConfig[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = normalFightTaskKey(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
