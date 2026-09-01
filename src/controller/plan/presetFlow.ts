/**
 * presetFlow —— 任务预设相关流程独立函数。
 */
import type { PlanPreviewView } from '../../view/plan/PlanPreviewView';
import type { TaskRequest } from '../../types/api';
import { TaskPriority } from '../../model/scheduler';
import type { TaskPreset } from '../../types/model';
import { TemplateController } from '../template/TemplateController';
import { Logger } from '../../utils/Logger';
import type { PlanHost } from '../contracts.js';
import type {
  PlanPresetSource,
  ShipLibraryShip,
} from '../../types/ipc.js';
import { toBackendDecisiveShipNames } from '../../shared/shipNameNormalizer.js';

export interface PresetState {
  currentPreset: TaskPreset | null;
  currentPresetFilePath: string;
  currentPresetSource: PlanPresetSource;
}

/** 导入任务预设，解析相对路径并显示详情面板 */
export function importTaskPresetFlow(
  preset: TaskPreset,
  filePath: string,
  planView: PlanPreviewView,
  host: PlanHost,
  state: PresetState,
  source: PlanPresetSource = 'user',
): void {
  if (preset.plan_id && !/^[A-Za-z]:[/\\]/.test(preset.plan_id) && !preset.plan_id.startsWith('/')) {
    const dir = filePath.replace(/[\\/][^\\/]+$/, '');
    preset.plan_id = dir + '\\' + preset.plan_id.replace(/\//g, '\\');
  }
  showPresetDetailFlow(preset, filePath, planView, state, source);
  host.switchPage('plan');
}

/** 显示任务预设详情面板 */
export function showPresetDetailFlow(
  preset: TaskPreset,
  filePath: string,
  planView: PlanPreviewView,
  state: PresetState,
  source: PlanPresetSource = 'user',
): void {
  state.currentPreset = preset;
  state.currentPresetFilePath = filePath;
  state.currentPresetSource = source;

  const name = filePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? preset.task_type;
  const typeLabel = TemplateController.TEMPLATE_TYPE_LABELS[preset.task_type] ?? preset.task_type;

  planView.showPresetDetail();
  planView.fillPresetDetailForm({
    name,
    typeLabel,
    taskType: preset.task_type,
    fleetId: preset.fleet_id,
    exerciseFleetId: preset.fleet_id,
    campaignName: preset.campaign_name,
    chapter: preset.chapter,
    level1: preset.level1,
    level2: preset.level2,
    flagshipPriority: preset.flagship_priority,
    useQuickRepair: preset.use_quick_repair,
    planId: preset.plan_id,
    times: preset.times,
  });
}

/** 关闭预设详情面板 */
export function closePresetDetailFlow(
  planView: PlanPreviewView,
  state: PresetState,
): void {
  state.currentPreset = null;
  state.currentPresetFilePath = '';
  state.currentPresetSource = 'user';
  planView.hidePresetDetail();
}

/** 从预设详情面板收集表单值，构建任务加入队列 */
export function executePresetFlow(
  planView: PlanPreviewView,
  host: PlanHost,
  state: PresetState,
  ships: readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[] = [],
): void {
  const preset = state.currentPreset;
  if (!preset) return;

  const name = state.currentPresetFilePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? preset.task_type;
  let req: TaskRequest;
  const formVals = planView.collectPresetFormValues();
  const times = formVals.times;

  switch (preset.task_type) {
    case 'exercise':
      req = { type: 'exercise', fleet_id: formVals.exerciseFleetId };
      break;
    case 'campaign':
      req = { type: 'campaign', campaign_name: formVals.campaignName!, times: 1 };
      break;
    case 'decisive': {
      const isSystemPreset = state.currentPresetSource === 'system';
      const shipNames = toBackendDecisiveShipNames(
        {
          level1: formVals.level1,
          level2: formVals.level2,
          flagship_priority: formVals.flagshipPriority,
        },
        isSystemPreset ? undefined : ships,
      );
      req = {
        type: 'decisive',
        chapter: formVals.chapter,
        ...shipNames,
        use_quick_repair: formVals.useQuickRepair,
      };
      break;
    }
    case 'event_fight':
      req = {
        type: 'event_fight',
        plan_id: formVals.planId,
        times: 1,
        gap: preset.gap ?? 0,
        fleet_id: formVals.fightFleetId || null,
      };
      break;
    case 'normal_fight':
    default:
      req = { type: 'normal_fight', plan_id: formVals.planId, times: 1, gap: preset.gap ?? 0 };
      break;
  }

  const effectiveTimes = preset.task_type === 'exercise' ? 1 : times;
  const stopCondition = preset.stop_condition;

  host.scheduler.addTask(name, preset.task_type, req, TaskPriority.USER_TASK, effectiveTimes, stopCondition);

  closePresetDetailFlow(planView, state);
  host.switchPage('main');
  host.renderMain();

  const parts: string[] = [];
  if (effectiveTimes > 1 || stopCondition) parts.push(`×${effectiveTimes}`);
  if (stopCondition?.loot_count_ge) parts.push(`战利品≥${stopCondition.loot_count_ge}时停止`);
  if (stopCondition?.ship_count_ge) parts.push(`舰船≥${stopCondition.ship_count_ge}时停止`);
  Logger.info(`任务「${name}」已加入队列${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
}
