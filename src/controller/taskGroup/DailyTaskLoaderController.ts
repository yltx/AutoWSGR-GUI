/** 管理日常任务浮窗的加载、分类、卡片参数和提交动作。 */
import type {
  DailyPlanSelection,
  DailyPlanType,
  ManagedDailyPlan,
} from '../../types/ipc.js';
import { DailyTaskLoaderView } from '../../view/taskGroup/DailyTaskLoaderView';
import { showAlert } from '../../view/shared/DialogHelper';
import {
  getTaskGroupRepository,
  type TaskGroupRepository,
} from '../../adapter/IpcAdapter';

export interface DailyTaskLoaderActions {
  addToList(selection: DailyPlanSelection): void;
  addToQueue(selection: DailyPlanSelection): Promise<void>;
}

/** 为任务列表提供独立于普通作战计划的日常任务选择流程。 */
export class DailyTaskLoaderController {
  private plans: ManagedDailyPlan[] = [];
  private activeType: DailyPlanType = 'exercise';
  private selectedPlan: ManagedDailyPlan | null = null;
  private readonly drafts = new Map<string, {
    times: number;
    useQuickRepair: boolean;
  }>();

  constructor(
    private readonly view: DailyTaskLoaderView,
    private readonly actions: DailyTaskLoaderActions,
    private readonly repository: TaskGroupRepository | undefined =
      getTaskGroupRepository(),
  ) {}

  bindActions(): void {
    this.view.bindActions({
      onClose: () => this.view.close(),
      onTabChange: type => this.changeTab(type),
      onSelect: plan => this.select(plan),
      onTimesChange: (plan, times) => {
        const draft = this.draft(plan);
        draft.times = Math.max(1, times);
        this.selectedPlan = plan;
        this.render();
      },
      onQuickRepairChange: (plan, useQuickRepair) => {
        const draft = this.draft(plan);
        draft.useQuickRepair = useQuickRepair;
        this.selectedPlan = plan;
        this.render();
      },
      onAddToList: () => this.addToList(),
      onAddToQueue: () => void this.addToQueue(),
    });
  }

  open(): void {
    this.view.open();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.repository?.listDailyPlans) {
      this.view.setStatus('请完整重启 GUI 后再操作');
      return;
    }
    this.view.setStatus('正在读取日常任务...');
    try {
      const result = await this.repository.listDailyPlans();
      this.plans = result.plans;
      this.plans.forEach(plan => this.draft(plan));
      const visible = this.visiblePlans();
      const selectedPlan = this.selectedPlan;
      if (
        !selectedPlan
        || !this.plans.some(plan => this.samePlan(plan, selectedPlan))
      ) {
        this.selectedPlan = visible[0] ?? null;
      }
      this.view.setStatus(
        result.errors.length > 0
          ? `${result.errors.length} 个日常任务 YAML 无法读取`
          : '',
      );
      this.render();
    } catch (error) {
      this.plans = [];
      this.selectedPlan = null;
      this.view.setStatus(
        `读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
      this.render();
    }
  }

  private changeTab(type: DailyPlanType): void {
    this.activeType = type;
    const visible = this.visiblePlans();
    if (
      !this.selectedPlan
      || this.selectedPlan.taskType !== type
    ) {
      this.selectedPlan = visible[0] ?? null;
    }
    this.render();
  }

  private select(plan: ManagedDailyPlan): void {
    this.selectedPlan = plan;
    this.render();
  }

  private addToList(): void {
    const selection = this.selection();
    if (!selection) return;
    this.actions.addToList(selection);
    this.view.close();
  }

  private async addToQueue(): Promise<void> {
    const selection = this.selection();
    if (!selection) return;
    try {
      await this.actions.addToQueue(selection);
      this.view.close();
    } catch (error) {
      await showAlert(
        '加入执行队列失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private selection(): DailyPlanSelection | null {
    if (!this.selectedPlan) return null;
    const draft = this.draft(this.selectedPlan);
    return {
      plan: this.selectedPlan,
      times: this.selectedPlan.taskType === 'exercise'
        ? 1
        : draft.times,
      useQuickRepair: this.selectedPlan.taskType === 'decisive'
        ? draft.useQuickRepair
        : undefined,
    };
  }

  private draft(plan: ManagedDailyPlan): {
    times: number;
    useQuickRepair: boolean;
  } {
    const key = this.planKey(plan);
    const existing = this.drafts.get(key);
    if (existing) return existing;
    const created = {
      times: Math.max(1, plan.times || 1),
      useQuickRepair: plan.useQuickRepair !== false,
    };
    this.drafts.set(key, created);
    return created;
  }

  private render(): void {
    this.view.render(
      this.plans,
      this.activeType,
      this.selection(),
    );
  }

  private visiblePlans(): ManagedDailyPlan[] {
    return this.plans.filter(plan => plan.taskType === this.activeType);
  }

  private samePlan(
    left: ManagedDailyPlan,
    right: ManagedDailyPlan,
  ): boolean {
    return left.source === right.source && left.file === right.file;
  }

  private planKey(plan: ManagedDailyPlan): string {
    return `${plan.source}/${plan.file}`;
  }
}
