/**
 * 连接日常任务计划服务与渲染进程。
 */
import type { DailyPlanService } from '../services/DailyPlanService';
import type { GuiConfigurationService } from '../services/GuiConfigurationService';
import type {
  DecisivePlanSettings,
} from '../../src/shared/decisivePlan';
import type { IpcRegistrar } from './IpcRegistrar';

export interface DailyPlanIpcDependencies {
  dailyPlans: DailyPlanService;
  configuration: GuiConfigurationService;
}

/** 注册日常任务列表、读取和按章节保存决战配置的 IPC。 */
export function registerDailyPlanIpc(
  ipc: IpcRegistrar,
  dependencies: DailyPlanIpcDependencies,
): void {
  ipc.handle('list-daily-plans', () => {
    return dependencies.dailyPlans.list();
  });

  ipc.handle(
    'read-daily-plan',
    (_event, source: 'system' | 'user', file: string) => {
      return dependencies.dailyPlans.read(source, file);
    },
  );

  ipc.handle('get-daily-decisive-plan', (_event, chapter: number) => {
    return dependencies.dailyPlans.decisivePlan(chapter);
  });

  ipc.handle(
    'get-system-daily-decisive-plan',
    (_event, chapter: number) => {
      return dependencies.dailyPlans.systemDecisivePlan(chapter);
    },
  );

  ipc.handle(
    'save-daily-decisive-plan',
    (_event, settings: DecisivePlanSettings) => {
      const saved = dependencies.dailyPlans.saveDecisivePlan(settings);
      return dependencies.configuration.setDecisivePlan(saved);
    },
  );
}
