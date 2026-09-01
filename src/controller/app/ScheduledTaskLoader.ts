/** 读取定时自动化计划，并转换为 Scheduler 任务。 */
import {
  getScheduledTaskRepository,
  type ScheduledTaskRepository,
} from '../../adapter/IpcAdapter';
import type { ConfigModel } from '../../model/ConfigModel';
import { PlanModel } from '../../model/PlanModel';
import {
  TaskPriority,
  uniqueNormalFightTasks,
  type NormalFightDailyQuota,
  type Scheduler,
} from '../../model/scheduler';
import type { TemplateModel } from '../../model/TemplateModel';
import {
  SYSTEM_DECISIVE_TEMPLATE_ID,
  USER_DECISIVE_PLAN_ID,
  normalizeDecisiveAutomationSource,
  type DecisiveAutomationSource,
} from '../../shared/decisiveAutomation.js';
import {
  normalizeLootAutomationPlan,
  type LootPlanSource,
} from '../../shared/lootPlans.js';
import type {
  DecisiveReq,
  EventFightReq,
  NormalFightReq,
} from '../../types/api.js';
import type {
  BattleResultGrade,
  NormalFightTaskConfig,
  StopCondition,
} from '../../types/model.js';
import { Logger } from '../../utils/Logger';
import {
  applyPlanNodeOverrides,
  buildPlanQueueRequest,
} from '../taskGroup/queueLoader';
import {
  buildAutomaticDecisivePlanRequest,
  buildAutomaticDecisivePresetRequest,
} from './AutomaticDecisiveTask';

export interface ScheduledTaskLoaderHost {
  readonly scheduler: Scheduler;
  readonly templateModel: TemplateModel;
  readonly configModel: ConfigModel;
  readonly normalFightDailyQuota: NormalFightDailyQuota;
}

export type NormalFightLoadResult =
  | {
      status: 'queued';
      tasks: Array<{
        taskId: string;
        config: NormalFightTaskConfig;
      }>;
    }
  | { status: 'handled' }
  | { status: 'retry' };

export class ScheduledTaskLoader {
  constructor(
    private readonly host: ScheduledTaskLoaderHost,
    private readonly repository:
      ScheduledTaskRepository | undefined =
        getScheduledTaskRepository(),
  ) {}

  async loadDecisiveTask(
    source: DecisiveAutomationSource,
  ): Promise<string> {
    const selectedSource = normalizeDecisiveAutomationSource(source);
    let label: string;
    let request: DecisiveReq;

    if (selectedSource === USER_DECISIVE_PLAN_ID) {
      if (!this.repository?.getDecisivePlanSettings) {
        throw new Error('决战计划读取接口不可用');
      }
      const [plan, shipLibrary] = await Promise.all([
        this.repository.getDecisivePlanSettings(),
        this.repository.getShipLibraryManifest(),
      ]);
      request = buildAutomaticDecisivePlanRequest(
        plan,
        shipLibrary.ships,
      );
      label = '用户计划';
    } else {
      const template = this.host.templateModel.get(
        SYSTEM_DECISIVE_TEMPLATE_ID,
      );
      if (!template || template.type !== 'decisive') {
        throw new Error('找不到系统决战预设');
      }
      request = buildAutomaticDecisivePresetRequest(template);
      label = '系统预设';
    }

    const taskId = this.host.scheduler.addTask(
      `自动决战·${label}`,
      'decisive',
      request,
      TaskPriority.DAILY,
      1,
    );
    Logger.info(
      `自动决战已加入队列 (${label}, 第 ${request.chapter} 章 ×1)`,
    );
    this.host.scheduler.startConsuming();
    return taskId;
  }

  async loadNormalFightTasks(): Promise<NormalFightLoadResult> {
    const tasks = this.host.configModel.current
      .daily_automation
      .normal_fight_tasks;
    if (tasks.length === 0) {
      Logger.warn('自动出征已启用，但任务列表为空');
      return { status: 'handled' };
    }
    if (!this.repository) return { status: 'retry' };
    const uniqueTasks = uniqueNormalFightTasks(tasks);
    if (uniqueTasks.length < tasks.length) {
      Logger.warn('自动出征存在重复的计划和舰队配置，本次仅执行一次');
    }
    const eligibleTasks = uniqueTasks.filter(task => (
      this.host.normalFightDailyQuota.remaining(task) > 0
    ));
    if (eligibleTasks.length === 0) {
      Logger.debug('自动出征今日执行次数已用完');
      return { status: 'handled' };
    }

    const preparedTasks: Array<{
      name: string;
      type: 'normal_fight' | 'event_fight';
      request: NormalFightReq | EventFightReq;
      config: NormalFightTaskConfig;
      stopCondition?: StopCondition;
      fleetId?: number;
      endpointNodes?: string[];
      endpointResult?: BattleResultGrade;
    }> = [];
    for (const task of eligibleTasks) {
      try {
        const resolved = await this.resolveNormalFightPlan(task);
        if (!resolved) {
          throw new Error(`找不到出征计划: ${task.name}`);
        }
        const plan = PlanModel.fromYaml(
          resolved.content,
          resolved.path,
        );
        const {
          req: request,
          selectedFleetId,
        } = buildPlanQueueRequest(
          {
            path: resolved.path,
            kind: 'plan',
            times: 1,
            label: plan.mapName,
            fleet_id: task.fleet_id,
            fleetPresetIndex: task.fleet_preset_index,
          },
          plan,
          resolved.path,
          this.host.configModel.current.ocr.ship_name_aliases,
        );
        preparedTasks.push({
          name: `自动出征·${plan.mapName}`,
          type: plan.isEvent ? 'event_fight' : 'normal_fight',
          request,
          config: structuredClone(task),
          stopCondition: plan.data.stop_condition,
          fleetId: selectedFleetId,
          endpointNodes: plan.data.endpoint_nodes,
          endpointResult: plan.data.result,
        });
      } catch (error) {
        Logger.error(
          `自动出征加载「${task.name}」失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (preparedTasks.length === 0) return { status: 'retry' };
    if (!this.host.scheduler.isCompletelyIdle) {
      Logger.debug('自动出征计划加载完成时调度器已非空闲，等待下次检查');
      return { status: 'retry' };
    }

    const queuedTasks = preparedTasks
      .filter(task => (
        this.host.normalFightDailyQuota.remaining(task.config) > 0
      ))
      .map(task => ({
        taskId: this.host.scheduler.addTask(
          task.name,
          task.type,
          task.request,
          TaskPriority.DAILY,
          1,
          task.stopCondition,
          undefined,
          task.fleetId,
          undefined,
          undefined,
          undefined,
          undefined,
          task.endpointNodes,
          task.endpointResult,
        ),
        config: task.config,
      }));
    if (queuedTasks.length === 0) return { status: 'handled' };
    Logger.info(
      `自动出征已按顺序加入 ${queuedTasks.length} 个单轮任务`,
    );
    return { status: 'queued', tasks: queuedTasks };
  }

  async loadLootTask(
    source: LootPlanSource,
    planId: string,
    stopCount: number,
  ): Promise<string | null> {
    const managedPlan = normalizeLootAutomationPlan({
      source,
      file: planId,
      name: planId,
    });
    if (!managedPlan) {
      throw new Error(`未知计划 ${String(planId)}`);
    }
    if (!this.repository) return null;

    const loaded = await this.repository.readManagedCombatPlan(
      managedPlan.source,
      managedPlan.file,
    );
    if (!loaded.success || !loaded.content || !loaded.path) {
      throw new Error(
        loaded.error || `无法读取 ${managedPlan.file}`,
      );
    }

    const planPath = loaded.runtimePath ?? loaded.path;
    const plan = PlanModel.fromYaml(loaded.content, planPath);
    const request: NormalFightReq | EventFightReq = plan.isEvent
      ? {
          type: 'event_fight',
          plan_id: planPath,
          times: 1,
          gap: plan.data.gap ?? 0,
          fleet_id: plan.data.fleet_id ?? 1,
        }
      : {
          type: 'normal_fight',
          plan_id: planPath,
          times: 1,
          gap: plan.data.gap ?? 0,
        };
    applyPlanNodeOverrides(request, plan);
    if (plan.data.fleet_id != null) {
      request.plan!.fleet_id = plan.data.fleet_id;
    }

    const taskId = this.host.scheduler.addTask(
      `自动刷胖次·${plan.mapName}`,
      plan.isEvent ? 'event_fight' : 'normal_fight',
      request,
      TaskPriority.DAILY,
      99,
      { loot_count_ge: stopCount },
    );
    Logger.info(
      `自动战利品已加入队列 (${
        plan.mapName
      }, 战利品≥${stopCount}时停止)`,
    );
    this.host.scheduler.startConsuming();
    return taskId;
  }

  private async resolveNormalFightPlan(
    task: NormalFightTaskConfig,
  ): Promise<{ path: string; content: string } | null> {
    if (!this.repository) return null;
    const planName = task.name.trim();
    const result = task.source
      ? await this.repository.readManagedCombatPlan(
          task.source,
          planName,
        )
      : await this.repository.readCombatPlanFile(planName);
    if (
      result.success
      && result.content?.trim()
      && result.path
    ) {
      return {
        path: result.runtimePath ?? result.path,
        content: result.content,
      };
    }
    return null;
  }
}
