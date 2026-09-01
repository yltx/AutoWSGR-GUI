/** 把任务组条目解析为 Scheduler 可执行任务并加入队列。 */
/**
 * queueLoader —— 将任务组条目加载到调度队列的独立函数。
 */
import type { TaskGroupModel, TaskGroupItem } from '../../model/TaskGroupModel';
import type { TemplateModel } from '../../model/TemplateModel';
import { PlanModel } from '../../model/PlanModel';
import { TaskPriority, type Scheduler } from '../../model/scheduler';
import type { EventFightReq, NormalFightReq, TaskRequest } from '../../types/api.js';
import type {
  DailyPlanSelection,
  ManagedBattlePlanSelection,
  ShipLibraryShip,
} from '../../types/ipc.js';
import type { TaskPreset } from '../../types/model.js';
import { resolveFleetPreset } from '../../model/fleet/ShipMatcher';
import { resolveFleetPresetRules } from '../../model/fleet/FleetRuleMapper';
import {
  toBackendDecisiveShipNames,
  toBackendName,
} from '../../shared/shipNameNormalizer';
import { taskPresetCodec } from '../../shared/taskPreset';
import { Logger } from '../../utils/Logger';
import {
  assertPlanRouteReadyForExecution,
  normalizeSelectedNodesForBackend,
} from '../plan/selectedNodes';
import type { TaskGroupHost } from '../contracts.js';
import { readTaskGroupItemFile } from './managedPlanReader';
import { parseYamlRecord } from '../../adapter';
import {
  getTaskGroupRepository,
  type TaskGroupRepository,
} from '../../adapter/IpcAdapter';

export function applyPlanNodeOverrides(
  req: NormalFightReq | EventFightReq,
  plan: PlanModel,
): void {
  req.plan = req.plan ?? {};
  const selectedNodes = normalizeSelectedNodesForBackend(
    plan.data.selected_nodes,
  );
  assertPlanRouteReadyForExecution(selectedNodes);
  req.plan.selected_nodes = selectedNodes;
  req.plan.node_defaults = structuredClone(plan.data.node_defaults ?? {});
  req.plan.node_args = plan.getNodeArgsForExecution();
}

export function buildPlanQueueRequest(
  item: TaskGroupItem,
  plan: PlanModel,
  planId: string,
  shipNameAliases: Readonly<Record<string, string>> = {},
): {
  req: NormalFightReq | EventFightReq;
  selectedFleetId: number | undefined;
} {
  const req: NormalFightReq | EventFightReq = {
    type: plan.isEvent ? 'event_fight' : 'normal_fight',
    plan_id: planId,
    times: 1,
    gap: plan.data.gap ?? 0,
  };
  applyPlanNodeOverrides(req, plan);

  const selectedFleetId = item.fleet_id ?? plan.data.fleet_id;
  if (selectedFleetId != null) {
    if (req.type === 'event_fight') req.fleet_id = selectedFleetId;
    req.plan = req.plan ?? {};
    req.plan.fleet_id = selectedFleetId;
  }

  const presets = plan.data.fleet_presets;
  if (presets?.length) {
    // 旧任务列表未保存索引时沿用原行为，默认使用第一支编队。
    const presetIndex = item.fleetPresetIndex ?? 0;
    const preset = presets[presetIndex];
    if (!preset) {
      throw new Error(`选择的使用舰队不存在（索引 ${presetIndex}）`);
    }
    const resolved = resolveFleetPreset(preset.ships);
    const rules = resolveFleetPresetRules(preset.ships, shipNameAliases);
    if (resolved.length === 0 || rules.length === 0) {
      throw new Error(`使用舰队「${preset.name}」没有可用舰船`);
    }

    // 后端覆盖请求只携带这一支编队，其他 fleet_presets 不进入请求。
    req.plan = req.plan ?? {};
    req.plan.fleet = resolved.map(toBackendName);
    req.plan.fleet_rules = rules;
  } else if (item.fleetPresetIndex != null) {
    throw new Error('作战计划中已没有所选使用舰队');
  }

  return { req, selectedFleetId };
}

interface PlanQueueHost {
  readonly scheduler: Scheduler;
  getShipNameAliases(): Readonly<Record<string, string>>;
  renderMain(): void;
}

async function decisiveShipsForItem(
  item: TaskGroupItem,
  preset: TaskPreset,
  repository: TaskGroupRepository,
): Promise<
  readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[] | undefined
> {
  const source = item.dailySource ?? item.managedSource;
  if (preset.task_type !== 'decisive' || source === 'system') {
    return undefined;
  }
  if (!repository.getShipLibraryManifest) {
    throw new Error('舰船资料库读取接口不可用');
  }
  return (await repository.getShipLibraryManifest()).ships;
}

async function decisiveShipsForTemplate(
  item: TaskGroupItem,
  templateModel: TemplateModel,
  repository: TaskGroupRepository | undefined,
): Promise<
  readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[] | undefined
> {
  const templateId = item.templateId ?? '';
  const template = templateModel.get(templateId);
  if (
    template?.type !== 'decisive'
    || templateModel.isBuiltin(templateId)
  ) {
    return undefined;
  }
  if (!repository?.getShipLibraryManifest) {
    throw new Error('舰船资料库读取接口不可用');
  }
  return (await repository.getShipLibraryManifest()).ships;
}

function addPlanTaskToQueue(
  item: TaskGroupItem,
  plan: PlanModel,
  planId: string,
  host: PlanQueueHost,
): void {
  const { req, selectedFleetId } = buildPlanQueueRequest(
    item,
    plan,
    planId,
    host.getShipNameAliases(),
  );
  // sortKey 不再传 chapter：从任务列表加入队列时一律按加入时间排序，
  // 让用户先加入的任务排在前面；批量加载（loadGroupToQueue）按 group.items 配置顺序入队。
  host.scheduler.addTask(
    plan.mapName,
    plan.isEvent ? 'event_fight' : 'normal_fight',
    req,
    TaskPriority.USER_TASK,
    item.times,
    plan.data.stop_condition,
    undefined,
    selectedFleetId,
    undefined,
    undefined,
    !!item.forceRetry,
    !!item.allowPolling,
    plan.data.endpoint_nodes,
    plan.data.result,
  );
}

/** 按任务预设类型构造请求并直接加入调度队列。 */
function addPresetTaskToQueue(
  item: TaskGroupItem,
  preset: TaskPreset,
  scheduler: Scheduler,
  ships?: readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[],
): void {
  let req: TaskRequest;
  if (preset.task_type === 'campaign') {
    req = {
      type: 'campaign',
      campaign_name: preset.campaign_name ?? '',
      times: 1,
    };
  } else if (preset.task_type === 'exercise') {
    req = {
      type: 'exercise',
      fleet_id: preset.fleet_id ?? 1,
    };
  } else if (preset.task_type === 'decisive') {
    req = {
      type: 'decisive',
      chapter: preset.chapter,
      ...toBackendDecisiveShipNames(preset, ships),
      use_quick_repair: item.useQuickRepair
        ?? preset.use_quick_repair
        ?? true,
    };
  } else {
    req = {
      type: preset.task_type,
      plan_id: preset.plan_id,
      times: 1,
      gap: preset.gap ?? 0,
      fleet_id: preset.fleet_id,
    };
  }
  const effectiveTimes = preset.task_type === 'exercise'
    ? 1
    : Math.max(1, item.times || preset.times || 1);
  scheduler.addTask(
    item.label,
    preset.task_type,
    req,
    TaskPriority.USER_TASK,
    effectiveTimes,
    preset.stop_condition,
    undefined,
    preset.fleet_id,
  );
}

/** 将计划浮窗选中的受管计划直接加入任务队列。 */
export async function loadManagedPlanToQueue(
  selection: ManagedBattlePlanSelection,
  host: PlanQueueHost,
): Promise<void> {
  const item: TaskGroupItem = {
    managedSource: selection.plan.source,
    managedFile: selection.plan.file,
    kind: selection.plan.kind === 'preset' ? 'preset' : 'plan',
    times: Math.max(1, selection.plan.times || 1),
    label: selection.plan.name,
    fleetPresetIndex: selection.fleetPresetIndex,
  };
  const repository = getTaskGroupRepository();
  if (!repository) throw new Error('Electron bridge is unavailable');
  const { content, path } = await readTaskGroupItemFile(item, repository);
  const parsed = parseYamlRecord(content, '任务文件');
  if (
    item.kind === 'preset'
    || taskPresetCodec.isStandalone(parsed)
  ) {
    const preset = taskPresetCodec.normalize(parsed);
    addPresetTaskToQueue(
      item,
      preset,
      host.scheduler,
      await decisiveShipsForItem(item, preset, repository),
    );
  } else {
    const plan = PlanModel.fromYaml(content, path);
    addPlanTaskToQueue(item, plan, path, host);
  }
  Logger.info(`已将「${selection.plan.name}」加入任务队列`);
  host.renderMain();
}

/** 将日常任务浮窗选中的卡片直接加入调度队列。 */
export async function loadDailyPlanToQueue(
  selection: DailyPlanSelection,
  host: PlanQueueHost,
): Promise<void> {
  const item: TaskGroupItem = {
    dailySource: selection.plan.source,
    dailyFile: selection.plan.file,
    dailyTaskType: selection.plan.taskType,
    kind: 'daily',
    times: selection.plan.taskType === 'exercise'
      ? 1
      : Math.max(1, selection.times),
    label: selection.plan.name,
    chapter: selection.plan.chapter,
    useQuickRepair: selection.plan.taskType === 'decisive'
      ? selection.useQuickRepair !== false
      : undefined,
  };
  const repository = getTaskGroupRepository();
  if (!repository) throw new Error('Electron bridge is unavailable');
  const { content } = await readTaskGroupItemFile(item, repository);
  const preset = taskPresetCodec.normalize(
    parseYamlRecord(content, '日常任务'),
  );
  addPresetTaskToQueue(
    item,
    preset,
    host.scheduler,
    await decisiveShipsForItem(item, preset, repository),
  );
  Logger.info(`已将日常任务「${selection.plan.name}」加入任务队列`);
  host.renderMain();
}

/** 加载整个任务组到调度队列 */
export async function loadGroupToQueue(
  taskGroupModel: TaskGroupModel,
  templateModel: TemplateModel,
  host: TaskGroupHost,
): Promise<void> {
  const group = taskGroupModel.getActiveGroup();
  if (!group || group.items.length === 0) { Logger.warn('当前任务组为空'); return; }
  const repository = getTaskGroupRepository();
  if (!repository) return;

  let loadedCount = 0;
  for (const item of group.items) {
    try {
      if (item.kind === 'template') {
        const ships = await decisiveShipsForTemplate(
          item,
          templateModel,
          repository,
        );
        loadedCount += loadTemplateToQueue(
          item,
          templateModel,
          host,
          ships,
        ) ? 1 : 0;
        continue;
      }

      const { content, path } = await readTaskGroupItemFile(
        item,
        repository,
      );
      const parsed = parseYamlRecord(content, '任务文件');

      if (
        item.kind === 'preset'
        || taskPresetCodec.isStandalone(parsed)
      ) {
        const preset = taskPresetCodec.normalize(parsed);
        addPresetTaskToQueue(
          item,
          preset,
          host.scheduler,
          await decisiveShipsForItem(item, preset, repository),
        );
      } else {
        const plan = PlanModel.fromYaml(content, path);
        addPlanTaskToQueue(item, plan, plan.fileName, host);
      }
      loadedCount++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error(`加载「${item.label}」失败: ${msg}`);
    }
  }

  if (loadedCount > 0) {
    Logger.info(`已从任务组「${group.name}」加载 ${loadedCount} 个任务到队列`);
    host.switchPage('main');
    host.renderMain();
  }
}

/** 将模板类型条目加载到调度队列 */
export function loadTemplateToQueue(
  item: TaskGroupItem,
  templateModel: TemplateModel,
  host: TaskGroupHost,
  ships?: readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[],
): boolean {
  const tpl = templateModel.get(item.templateId ?? '');
  if (!tpl) { Logger.error(`模板「${item.label}」不存在，可能已被删除`); return false; }

  let req: TaskRequest;
  const times = item.times;
  const allowPolling = item.allowPolling ?? tpl.allowPolling ?? false;

  switch (tpl.type) {
    case 'exercise':
      req = { type: 'exercise', fleet_id: item.fleet_id ?? tpl.fleet_id ?? 1 };
      host.scheduler.addTask(item.label || tpl.name, 'exercise', req, TaskPriority.USER_TASK, 1, undefined, undefined, undefined, undefined, undefined, undefined, allowPolling);
      break;
    case 'campaign': {
      const cName = item.campaignName ?? tpl.campaign_name ?? '困难潜艇';
      req = { type: 'campaign', campaign_name: cName, times: 1 };
      host.scheduler.addTask(item.label || tpl.name, 'campaign', req, TaskPriority.USER_TASK, times, undefined, undefined, undefined, undefined, undefined, undefined, allowPolling);
      break;
    }
    case 'decisive': {
      req = {
        type: 'decisive',
        chapter: item.chapter ?? tpl.chapter ?? 6,
        ...toBackendDecisiveShipNames(tpl, ships),
        use_quick_repair: tpl.use_quick_repair,
      };
      host.scheduler.addTask(item.label || tpl.name, 'decisive', req, TaskPriority.USER_TASK, times, undefined, undefined, undefined, undefined, undefined, undefined, allowPolling);
      break;
    }
    default:
      return false;
  }
  return true;
}

/** 加载单个条目到队列（拖拽触发） */
export async function loadSingleItemToQueue(
  index: number,
  taskGroupModel: TaskGroupModel,
  templateModel: TemplateModel,
  host: TaskGroupHost,
): Promise<void> {
  const group = taskGroupModel.getActiveGroup();
  if (!group) return;
  const item = group.items[index];
  if (!item) return;
  const repository = getTaskGroupRepository();

  if (item.kind === 'template') {
    try {
      const ships = await decisiveShipsForTemplate(
        item,
        templateModel,
        repository,
      );
      loadTemplateToQueue(item, templateModel, host, ships);
      Logger.info(`已将「${item.label}」加入队列`);
      host.renderMain();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error(`加载「${item.label}」失败: ${msg}`);
    }
    return;
  }

  if (!repository) return;

  try {
    const { content, path } = await readTaskGroupItemFile(
      item,
      repository,
    );
    const parsed = parseYamlRecord(content, '任务文件');

    if (
      item.kind === 'preset'
      || taskPresetCodec.isStandalone(parsed)
    ) {
      const preset = taskPresetCodec.normalize(parsed);
      addPresetTaskToQueue(
        item,
        preset,
        host.scheduler,
        await decisiveShipsForItem(item, preset, repository),
      );
    } else {
      const plan = PlanModel.fromYaml(content, path);
      addPlanTaskToQueue(item, plan, plan.fileName, host);
    }

    Logger.info(`已将「${item.label}」加入队列`);
    host.renderMain();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error(`加载「${item.label}」失败: ${msg}`);
  }
}
