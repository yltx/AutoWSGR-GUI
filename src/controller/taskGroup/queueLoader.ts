/**
 * queueLoader —— 将任务组条目加载到调度队列的独立函数。
 */
import type { TaskGroupModel, TaskGroupItem } from '../../model/TaskGroupModel';
import type { TemplateModel } from '../../model/TemplateModel';
import { PlanModel } from '../../model/PlanModel';
import { TaskPriority } from '../../model/scheduler';
import type { NormalFightReq, TaskRequest } from '../../types/api';
import type { TaskPreset } from '../../types/model';
import { resolveFleetPreset, resolveFleetPresetRules, toBackendName } from '../../data/shipData';
import { Logger } from '../../utils/Logger';
import type { TaskGroupHost } from './TaskGroupController';

/** 加载整个任务组到调度队列 */
export async function loadGroupToQueue(
  taskGroupModel: TaskGroupModel,
  templateModel: TemplateModel,
  host: TaskGroupHost,
): Promise<void> {
  const group = taskGroupModel.getActiveGroup();
  if (!group || group.items.length === 0) { Logger.warn('当前任务组为空'); return; }
  const bridge = window.electronBridge;
  if (!bridge) return;

  let loadedCount = 0;
  for (const item of group.items) {
    try {
      if (item.kind === 'template') {
        loadedCount += loadTemplateToQueue(item, templateModel, host) ? 1 : 0;
        continue;
      }

      const content = await bridge.readFile(item.path!);
      const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') continue;

      if (item.kind === 'preset' || ('task_type' in parsed && !('chapter' in parsed))) {
        host.importTaskPreset(parsed as unknown as TaskPreset, item.path!);
      } else {
        const plan = PlanModel.fromYaml(content, item.path!);
        const times = item.times;
        const req: NormalFightReq = {
          type: 'normal_fight',
          plan_id: plan.fileName,
          times: 1,
          gap: plan.data.gap ?? 0,
        };
        if (plan.data.selected_nodes.length > 0) {
          req.plan = req.plan ?? {};
          req.plan.selected_nodes = [...plan.data.selected_nodes];
        }
        let selectedFleetId = item.fleet_id ?? plan.data.fleet_id;
        if (item.autoFleetFallback && selectedFleetId === 1) {
          selectedFleetId = 2;
        }
        if (selectedFleetId != null) {
          req.plan = req.plan ?? {};
          req.plan.fleet_id = selectedFleetId;
        }
        if (item.fleetPresetIndex != null && plan.data.fleet_presets) {
          const preset = plan.data.fleet_presets[item.fleetPresetIndex];
          if (preset) {
            const resolved = resolveFleetPreset(preset.ships);
            if (resolved.length > 0) {
              req.plan = req.plan ?? {};
              req.plan.fleet = resolved.map(toBackendName);
              req.plan.fleet_rules = resolveFleetPresetRules(preset.ships);
            }
          }
        }
        host.scheduler.addTask(
          plan.mapName,
          'normal_fight',
          req,
          TaskPriority.USER_TASK,
          times,
          plan.data.stop_condition,
          undefined,
          selectedFleetId,
          undefined,
          undefined,
          !!item.forceRetry,
          !!item.allowPolling,
        );
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
    case 'decisive':
      req = {
        type: 'decisive',
        chapter: item.chapter ?? tpl.chapter ?? 6,
        level1: tpl.level1 ?? [],
        level2: tpl.level2 ?? [],
        flagship_priority: tpl.flagship_priority ?? [],
        use_quick_repair: tpl.use_quick_repair,
      };
      host.scheduler.addTask(item.label || tpl.name, 'decisive', req, TaskPriority.USER_TASK, times, undefined, undefined, undefined, undefined, undefined, undefined, allowPolling);
      break;
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

  if (item.kind === 'template') {
    loadTemplateToQueue(item, templateModel, host);
    Logger.info(`已将「${item.label}」加入队列`);
    host.renderMain();
    return;
  }

  const bridge = window.electronBridge;
  if (!bridge) return;

  try {
    const content = await bridge.readFile(item.path!);
    const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return;

    if (item.kind === 'preset' || ('task_type' in parsed && !('chapter' in parsed))) {
      host.importTaskPreset(parsed as unknown as TaskPreset, item.path!);
    } else {
      const plan = PlanModel.fromYaml(content, item.path!);
      const req: NormalFightReq = {
        type: 'normal_fight',
        plan_id: plan.fileName,
        times: 1,
        gap: plan.data.gap ?? 0,
      };
      if (plan.data.selected_nodes.length > 0) {
        req.plan = req.plan ?? {};
        req.plan.selected_nodes = [...plan.data.selected_nodes];
      }
      let selectedFleetId = item.fleet_id ?? plan.data.fleet_id;
      if (item.autoFleetFallback && selectedFleetId === 1) {
        selectedFleetId = 2;
      }
      if (selectedFleetId != null) {
        req.plan = req.plan ?? {};
        req.plan.fleet_id = selectedFleetId;
      }
      if (item.fleetPresetIndex != null && plan.data.fleet_presets) {
        const preset = plan.data.fleet_presets[item.fleetPresetIndex];
        if (preset) {
          const resolved = resolveFleetPreset(preset.ships);
          if (resolved.length > 0) {
            req.plan = req.plan ?? {};
            req.plan.fleet = resolved.map(toBackendName);
            req.plan.fleet_rules = resolveFleetPresetRules(preset.ships);
          }
        }
      }
      host.scheduler.addTask(
        plan.mapName,
        'normal_fight',
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
      );
    }

    Logger.info(`已将「${item.label}」加入队列`);
    host.renderMain();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error(`加载「${item.label}」失败: ${msg}`);
  }
}
