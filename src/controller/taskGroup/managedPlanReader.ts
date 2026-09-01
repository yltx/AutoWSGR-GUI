/** 读取受管作战方案并统一返回内容和来源信息。 */
/**
 * Reads a task-list item from either the managed plan directories or a
 * legacy/local file path.
 */
import type { TaskGroupItem } from '../../model/TaskGroupModel';
import {
  getTaskGroupRepository,
  type TaskGroupRepository,
} from '../../adapter/IpcAdapter';

export interface TaskGroupItemFile {
  content: string;
  path: string;
}

export async function readTaskGroupItemFile(
  item: TaskGroupItem,
  repository: TaskGroupRepository | undefined =
    getTaskGroupRepository(),
): Promise<TaskGroupItemFile> {
  if (!repository) throw new Error('Electron bridge is unavailable');

  if (item.dailySource && item.dailyFile) {
    if (!repository.readDailyPlan) {
      throw new Error('当前 GUI 不支持读取日常任务目录');
    }
    const result = await repository.readDailyPlan(
      item.dailySource,
      item.dailyFile,
    );
    if (!result.success || result.content === undefined || !result.path) {
      throw new Error(result.error || `无法读取 ${item.dailyFile}`);
    }
    return {
      content: result.content,
      path: result.path,
    };
  }

  if (item.managedSource && item.managedFile) {
    if (!repository.readManagedCombatPlan) {
      throw new Error('当前 GUI 不支持读取计划管理目录');
    }
    const result = await repository.readManagedCombatPlan(
      item.managedSource,
      item.managedFile,
    );
    if (!result.success || result.content === undefined || !result.path) {
      throw new Error(result.error || `无法读取 ${item.managedFile}`);
    }
    return {
      content: result.content,
      path: result.runtimePath ?? result.path,
    };
  }

  if (!item.path) throw new Error('任务没有关联配置文件');
  if (repository.readCombatPlanFile) {
    const result = await repository.readCombatPlanFile(item.path);
    if (!result.success || result.content === undefined || !result.path) {
      throw new Error(result.error || `无法读取 ${item.path}`);
    }
    return {
      content: result.content,
      path: result.runtimePath ?? result.path,
    };
  }
  return {
    content: await repository.readFile!(item.path),
    path: item.path,
  };
}
