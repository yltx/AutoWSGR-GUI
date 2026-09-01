/** 处理任务组条目的右键菜单、编辑、复制和删除。 */
/**
 * contextMenu —— 右键上下文菜单逻辑。
 */
import type { TaskGroupModel } from '../../model/TaskGroupModel';
import type { Scheduler } from '../../model/scheduler';
import { PlanModel } from '../../model/PlanModel';
import { loadMapData, loadEventMapData } from '../../model/MapDataLoader';
import type { MapData } from '../../model/MapDataLoader';
import type { TaskPreset } from '../../types/model.js';
import type { PlanPresetSource } from '../../types/ipc.js';
import { taskPresetCodec } from '../../shared/taskPreset';
import { Logger } from '../../utils/Logger';
import { parseYamlRecord } from '../../adapter';
import {
  getTaskGroupRepository,
  type TaskGroupRepository,
} from '../../adapter/IpcAdapter';

export interface ContextMenuTarget {
  source: 'taskgroup' | 'queue';
  id: number | string;
}

export interface ContextMenuHost {
  readonly scheduler: Scheduler;
  importTaskPreset(preset: TaskPreset, filePath: string): void;
  setCurrentPlan(plan: PlanModel, mapData: MapData | null): void;
  renderPlanPreview(): void;
  switchPage(page: string): void;
  openManagedPlan(file: string, source: PlanPresetSource): Promise<boolean>;
}

export function createContextMenuTarget(
  source: 'taskgroup' | 'queue',
  id: number | string,
): ContextMenuTarget {
  return { source, id };
}

export async function handleContextMenuEdit(
  target: ContextMenuTarget | null,
  taskGroupModel: TaskGroupModel,
  host: ContextMenuHost,
): Promise<void> {
  if (!target) return;

  if (target.source === 'taskgroup') {
    const group = taskGroupModel.getActiveGroup();
    if (!group) return;
    const item = group.items[target.id as number];
    if (!item) return;
    if (item.kind === 'template') {
      Logger.info(`模板「${item.label}」请在模板库中查看和编辑`);
      return;
    }
    if (item.kind === 'daily') {
      Logger.info(
        item.dailyTaskType === 'decisive'
          ? `决战日常任务「${item.label}」请在决战计划页面编辑`
          : `日常任务「${item.label}」由日常任务浮窗管理`,
      );
      return;
    }
    if (item.managedSource && item.managedFile) {
      await host.openManagedPlan(item.managedFile, item.managedSource);
      return;
    }
    if (!item.path) {
      Logger.error(`「${item.label}」没有关联的配置文件`);
      return;
    }
    await openItemForEdit(item.path!, item.kind, host);
  } else {
    const taskId = target.id as string;
    const task = host.scheduler.findTask(taskId);
    if (!task) return;

    const req = task.request;
    let planId: string | undefined;
    if (req.type === 'normal_fight' || req.type === 'event_fight') {
      planId = req.plan_id ?? undefined;
    }
    if (planId) {
      await openItemForEdit(planId, 'plan', host);
    } else {
      Logger.warn(`「${task.name}」没有关联的方案文件`);
    }
  }
}

export async function openItemForEdit(
  filePath: string,
  kind: 'plan' | 'preset',
  host: ContextMenuHost,
  repository: TaskGroupRepository | undefined =
    getTaskGroupRepository(),
): Promise<void> {
  if (!repository) return;

  try {
    const content = await repository.readFile!(filePath);
    const parsed = parseYamlRecord(content, '任务文件');

    if (
      kind === 'preset'
      || taskPresetCodec.isStandalone(parsed)
    ) {
      host.importTaskPreset(
        taskPresetCodec.normalize(parsed),
        filePath,
      );
    } else {
      const plan = PlanModel.fromYaml(content, filePath);
      const { chapter, map } = plan.data;
      const mapData = plan.isEvent
        ? await loadEventMapData(plan.data.event ?? '', chapter, map)
        : await loadMapData(Number(chapter), Number(map));
      host.setCurrentPlan(plan, mapData);
      host.renderPlanPreview();
    }
    host.switchPage('plan');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error(`打开编辑失败: ${msg}`);
  }
}
