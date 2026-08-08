/** 将方案、模板和预设添加为任务组条目。 */
/**
 * addItems —— 向任务组添加条目的独立函数。
 */
import type { TaskGroupModel } from '../../model/TaskGroupModel';
import type { PlanModel } from '../../model/PlanModel';
import type { TaskPreset } from '../../types/model.js';
import type {
  DailyPlanSelection,
  ManagedBattlePlan,
} from '../../types/ipc.js';
import { Logger } from '../../utils/Logger';
import {
  getTaskGroupRepository,
  type TaskGroupRepository,
} from '../../adapter/IpcAdapter';

function buildInlinePlanPath(plan: PlanModel, plansDir: string): string {
  const safeMap = plan.mapName.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const fileName = `_ui_inline_${safeMap}_${ts}.yaml`;
  return plansDir ? `${plansDir}\\${fileName}` : fileName;
}

function ensureActiveGroup(taskGroupModel: TaskGroupModel) {
  let group = taskGroupModel.getActiveGroup();
  if (!group) {
    taskGroupModel.upsertGroup('默认');
    taskGroupModel.setActiveGroup('默认');
    group = taskGroupModel.getActiveGroup()!;
  }
  return group;
}

/** 将计划管理中的系统或用户方案添加到任务列表 */
export function addManagedPlanToGroup(
  taskGroupModel: TaskGroupModel,
  plan: ManagedBattlePlan,
  fleetPresetIndex: number | undefined,
  render: () => void,
): void {
  const group = ensureActiveGroup(taskGroupModel);
  taskGroupModel.addItem(group.name, {
    managedSource: plan.source,
    managedFile: plan.file,
    kind: plan.kind === 'preset' ? 'preset' : 'plan',
    times: Math.max(1, plan.times || 1),
    label: plan.name,
    fleetPresetIndex,
  });
  void taskGroupModel.save();
  render();
  Logger.info(`已将「${plan.name}」加入任务列表「${group.name}」`);
}

/** 将日常任务加入任务列表，并保存卡片上的次数和快修选择。 */
export function addDailyPlanToGroup(
  taskGroupModel: TaskGroupModel,
  selection: DailyPlanSelection,
  render: () => void,
): void {
  const group = ensureActiveGroup(taskGroupModel);
  const { plan } = selection;
  taskGroupModel.addItem(group.name, {
    dailySource: plan.source,
    dailyFile: plan.file,
    dailyTaskType: plan.taskType,
    kind: 'daily',
    times: plan.taskType === 'exercise'
      ? 1
      : Math.max(1, selection.times),
    label: plan.name,
    chapter: plan.chapter,
    useQuickRepair: plan.taskType === 'decisive'
      ? selection.useQuickRepair !== false
      : undefined,
  });
  void taskGroupModel.save();
  render();
  Logger.info(`已将日常任务「${plan.name}」加入任务列表「${group.name}」`);
}

/** 将当前已加载的 Plan 添加到任务组 */
export async function addCurrentPlanToGroup(
  taskGroupModel: TaskGroupModel,
  getCurrentPlan: () => PlanModel | null,
  plansDir: string,
  render: () => void,
  repository: TaskGroupRepository | undefined =
    getTaskGroupRepository(),
): Promise<void> {
  const plan = getCurrentPlan();
  if (!plan) { Logger.warn('没有已加载的方案'); return; }
  if (!repository) return;

  let fileName = plan.fileName?.trim();
  if (!fileName) {
    fileName = buildInlinePlanPath(plan, plansDir);
    plan.fileName = fileName;
    Logger.warn(`当前方案未保存，已自动保存为临时方案: ${fileName}`);
  }

  await repository.saveFile!(fileName, plan.toYaml());

  const group = ensureActiveGroup(taskGroupModel);
  const times = plan.data.times ?? 1;
  const label = fileName.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? fileName;

  taskGroupModel.addItem(group.name, { path: fileName, kind: 'plan', times, label });
  taskGroupModel.save();
  render();
  Logger.info(`已将「${label} ×${times}」加入任务组「${group.name}」`);
}

/** 将当前任务预设添加到任务组 */
export function addPresetToGroup(
  taskGroupModel: TaskGroupModel,
  getCurrentPresetInfo: () => { preset: TaskPreset; filePath: string } | null,
  times: number,
  render: () => void,
): void {
  const info = getCurrentPresetInfo();
  if (!info) { Logger.warn('没有已加载的任务预设'); return; }
  const group = ensureActiveGroup(taskGroupModel);
  const normalizedTimes = Math.max(1, Math.trunc(times) || 1);
  const label = info.filePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? info.preset.task_type;

  taskGroupModel.addItem(group.name, {
    path: info.filePath,
    kind: 'preset',
    times: normalizedTimes,
    label,
  });
  taskGroupModel.save();
  render();
  Logger.info(
    `已将「${label} ×${normalizedTimes}」加入任务组「${group.name}」`,
  );
}
