/** 渲染“日常任务”浮窗中的页签、卡片和可编辑执行参数。 */
import type {
  DailyPlanSelection,
  DailyPlanType,
  ManagedDailyPlan,
} from '../../types/ipc.js';
import { LoaderDialog } from '../shared/LoaderDialog';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';

export interface DailyTaskLoaderViewActions {
  onClose(): void;
  onTabChange(type: DailyPlanType): void;
  onSelect(plan: ManagedDailyPlan): void;
  onTimesChange(plan: ManagedDailyPlan, times: number): void;
  onQuickRepairChange(
    plan: ManagedDailyPlan,
    useQuickRepair: boolean,
  ): void;
  onAddToList(): void;
  onAddToQueue(): void;
}

/** 只负责 DOM 展示，业务选择和执行由控制器处理。 */
export class DailyTaskLoaderView {
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly addToList: HTMLButtonElement;
  private readonly addToQueue: HTMLButtonElement;
  private readonly modal: LoaderDialog;

  constructor() {
    this.overlay = document.getElementById('daily-task-loader')!;
    this.list = document.getElementById('daily-task-loader-list')!;
    this.status = document.getElementById('daily-task-loader-status')!;
    this.addToList = document.getElementById(
      'btn-daily-task-add-list',
    ) as HTMLButtonElement;
    this.addToQueue = document.getElementById(
      'btn-daily-task-add-queue',
    ) as HTMLButtonElement;
    this.modal = new LoaderDialog(this.overlay);
  }

  bindActions(actions: DailyTaskLoaderViewActions): void {
    document.getElementById('btn-close-daily-task-loader')
      ?.addEventListener('click', actions.onClose);
    this.addToList.addEventListener('click', actions.onAddToList);
    this.addToQueue.addEventListener('click', actions.onAddToQueue);
    this.modal.bindDismiss(actions.onClose);
    this.overlay.querySelectorAll<HTMLButtonElement>(
      '[data-daily-task-tab]',
    ).forEach((button) => {
      button.addEventListener('click', () => {
        actions.onTabChange(
          button.dataset['dailyTaskTab'] as DailyPlanType,
        );
      });
    });
    this.actions = actions;
  }

  private actions: DailyTaskLoaderViewActions | null = null;

  open(): void {
    this.modal.open();
  }

  close(): void {
    this.modal.close();
  }

  setStatus(message: string): void {
    this.status.textContent = message;
    this.status.hidden = !message;
  }

  render(
    plans: readonly ManagedDailyPlan[],
    activeType: DailyPlanType,
    selected: DailyPlanSelection | null,
  ): void {
    this.overlay.querySelectorAll<HTMLButtonElement>(
      '[data-daily-task-tab]',
    ).forEach((button) => {
      button.classList.toggle(
        'active',
        button.dataset['dailyTaskTab'] === activeType,
      );
    });

    const scrollPosition = captureScrollPosition(this.list);
    this.list.innerHTML = '';
    const visible = plans.filter(plan => plan.taskType === activeType);
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'daily-task-loader-empty';
      empty.textContent = '当前分类暂无可用日常任务。';
      this.list.appendChild(empty);
    } else {
      visible.forEach(plan => (
        this.list.appendChild(this.createCard(plan, selected))
      ));
    }
    restoreScrollPosition(this.list, scrollPosition);
    this.addToList.disabled = selected === null;
    this.addToQueue.disabled = selected === null;
  }

  private createCard(
    plan: ManagedDailyPlan,
    selected: DailyPlanSelection | null,
  ): HTMLElement {
    const isSelected = selected?.plan.source === plan.source
      && selected.plan.file === plan.file;
    const card = document.createElement('article');
    card.className = `daily-task-card${isSelected ? ' selected' : ''}`;
    card.tabIndex = 0;
    card.addEventListener('click', () => this.actions?.onSelect(plan));
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.actions?.onSelect(plan);
    });

    const heading = document.createElement('div');
    heading.className = 'daily-task-card-heading';
    const tag = document.createElement('span');
    tag.className = 'daily-task-card-tag';
    tag.textContent = '日常任务';
    const source = document.createElement('span');
    source.className = (
      `tg-source daily-task-card-source ${plan.source}`
    );
    source.textContent = plan.source === 'system'
      ? '系统预设'
      : '用户配置';

    const name = document.createElement('h4');
    name.textContent = plan.name;
    heading.append(tag, name);

    if (plan.taskType === 'campaign' || plan.taskType === 'decisive') {
      const controls = document.createElement('div');
      controls.className = 'daily-task-card-controls';
      controls.addEventListener('click', event => event.stopPropagation());

      const timesField = document.createElement('label');
      timesField.className = 'daily-task-times';
      const timesLabel = document.createElement('span');
      timesLabel.textContent = '执行次数';
      const times = document.createElement('input');
      times.className = 'input';
      times.type = 'number';
      times.min = '1';
      times.max = '9999';
      times.value = String(isSelected ? selected.times : plan.times);
      times.addEventListener('change', () => {
        const value = Math.max(1, Number.parseInt(times.value, 10) || 1);
        times.value = String(value);
        this.actions?.onTimesChange(plan, value);
      });
      timesField.append(timesLabel, times);
      controls.appendChild(timesField);

      if (plan.taskType === 'decisive') {
        const quickRepair = document.createElement('label');
        quickRepair.className = 'config-switch daily-task-quick-repair';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = isSelected
          ? selected.useQuickRepair !== false
          : plan.useQuickRepair !== false;
        input.addEventListener('change', () => {
          this.actions?.onQuickRepairChange(plan, input.checked);
        });
        const track = document.createElement('span');
        track.className = 'config-switch-track';
        track.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = '使用快修';
        quickRepair.append(input, track, label);
        controls.appendChild(quickRepair);
      }
      heading.appendChild(controls);
    }

    heading.appendChild(source);
    card.appendChild(heading);
    return card;
  }
}
