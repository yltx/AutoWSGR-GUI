/** 把模板参数实例化为可加入任务组的任务条目。 */
/**
 * useTemplate —— 模板应用到任务列表的逻辑。
 */
import type { TemplateModel } from '../../model/TemplateModel';
import type { TaskGroupModel } from '../../model/TaskGroupModel';
import type { TaskTemplate } from '../../types/model.js';
import { Logger } from '../../utils/Logger';

export interface UseTemplateCallbacks {
  showPlanSelector(tpl: TaskTemplate, paths: string[], groupName: string): void;
  showCampaignSelector(tpl: TaskTemplate, groupName: string): void;
  showExerciseFleetSelector(tpl: TaskTemplate, groupName: string): void;
  showDecisiveChapterSelector(tpl: TaskTemplate, groupName: string): void;
}

/** 使用模板 → 加入任务列表 */
export async function useTemplateFlow(
  id: string,
  templateModel: TemplateModel,
  taskGroupModel: TaskGroupModel,
  renderTaskGroup: () => void,
  callbacks: UseTemplateCallbacks,
): Promise<void> {
  const tpl = templateModel.get(id);
  if (!tpl) return;

  let group = taskGroupModel.getActiveGroup();
  if (!group) {
    taskGroupModel.upsertGroup('默认');
    taskGroupModel.setActiveGroup('默认');
    group = taskGroupModel.getActiveGroup()!;
  }

  if (tpl.type === 'normal_fight' || tpl.type === 'event_fight') {
    const paths = tpl.planPaths ?? (tpl.planPath ? [tpl.planPath] : []);
    if (paths.length === 0) { Logger.warn(`模板「${tpl.name}」缺少方案文件路径`); return; }
    if (paths.length === 1) {
      addPlanToTaskList(tpl, paths[0], group.name, taskGroupModel);
    } else {
      callbacks.showPlanSelector(tpl, paths, group.name);
      return;
    }
  } else if (tpl.type === 'campaign') {
    callbacks.showCampaignSelector(tpl, group.name);
    return;
  } else if (tpl.type === 'exercise') {
    callbacks.showExerciseFleetSelector(tpl, group.name);
    return;
  } else if (tpl.type === 'decisive') {
    callbacks.showDecisiveChapterSelector(tpl, group.name);
    return;
  } else {
    taskGroupModel.addItem(group.name, {
      templateId: tpl.id,
      kind: 'template',
      times: tpl.defaultTimes ?? 1,
      label: tpl.name,
    });
  }

  taskGroupModel.save();
  renderTaskGroup();
  Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${group.name}」`);
}

/** 将方案添加到任务列表条目 */
export function addPlanToTaskList(
  tpl: TaskTemplate,
  planPath: string,
  groupName: string,
  taskGroupModel: TaskGroupModel,
  fleetPresetIndex?: number,
  presetName?: string,
  fleetId?: number,
): void {
  const planName = planPath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? tpl.name;
  const label = presetName
    ? `${tpl.name} (${planName} · ${presetName})`
    : `${tpl.name} (${planName})`;
  taskGroupModel.addItem(groupName, {
    path: planPath,
    kind: 'plan',
    times: tpl.defaultTimes ?? 1,
    label,
    fleetPresetIndex,
    fleet_id: fleetId,
    forceRetry: tpl.forceRetry,
    allowPolling: tpl.allowPolling,
  });
}
