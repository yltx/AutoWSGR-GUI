/** 渲染连接、运行状态、当前任务和远征倒计时。 */
import type { MainViewObject } from '../../types/view.js';
import { resolveTaskProgressPercent } from './TaskQueueView';

export type OperationName =
  | 'expedition'
  | 'reward'
  | 'buildCollect'
  | 'cook'
  | 'repair'
  | 'intensify';

export class StatusBar {
  private statusDot: HTMLElement;
  private statusText: HTMLElement;
  private expeditionTimer: HTMLElement;
  private taskState: HTMLElement;
  private taskName: HTMLElement;
  private taskRemaining: HTMLElement;
  private taskProgress: HTMLElement;
  private taskProgressFill: HTMLElement;

  private readonly operationButtons: Record<
    OperationName,
    HTMLButtonElement | null
  >;
  private operationsConnected = false;

  onOperation?: (operation: OperationName) => void;

  constructor() {
    this.statusDot = document.getElementById('status-dot')!;
    this.statusText = document.getElementById('status-text')!;
    this.expeditionTimer = document.getElementById('expedition-timer')!;
    this.taskState = document.getElementById('nav-task-state')!;
    this.taskName = document.getElementById('nav-task-name')!;
    this.taskRemaining = document.getElementById('nav-task-remaining')!;
    this.taskProgress = document.getElementById('nav-task-progress')!;
    this.taskProgressFill = document.getElementById('nav-task-progress-fill')!;
    this.operationButtons = {
      expedition: this.getButton('btn-ops-expedition'),
      reward: this.getButton('btn-ops-reward'),
      buildCollect: this.getButton('btn-ops-build-collect'),
      cook: this.getButton('btn-ops-cook'),
      repair: this.getButton('btn-ops-repair'),
      intensify: this.getButton('btn-ops-intensify'),
    };
    for (const [operation, button] of Object.entries(
      this.operationButtons,
    ) as [OperationName, HTMLButtonElement | null][]) {
      button?.addEventListener('click', () => {
        this.onOperation?.(operation);
      });
    }
  }

  render(vo: MainViewObject): void {
    this.statusDot.className = `status-indicator ${vo.status}`;
    this.statusText.textContent = vo.statusText;
    this.expeditionTimer.textContent = vo.expeditionTimer;

    const running = vo.taskQueue.find(item => item.id === vo.runningTaskId);
    if (!running) {
      this.taskState.classList.remove('active');
      this.taskState.title = '当前无运行任务';
      this.taskName.textContent = '当前无任务';
      this.taskRemaining.textContent = '剩余 0/0';
      this.taskProgressFill.style.width = '0%';
      this.taskProgress.setAttribute('aria-valuenow', '0');
      return;
    }

    const progressPercent = resolveTaskProgressPercent(running, true);
    const progressValue = Math.round(progressPercent * 100);
    const remainingText = running.unlimited
      ? '无限'
      : `${running.remaining}/${running.totalTimes}`;
    this.taskState.classList.add('active');
    this.taskState.title = `${running.name}，剩余 ${remainingText}`;
    this.taskName.textContent = running.name;
    this.taskRemaining.textContent = `剩余 ${remainingText}`;
    this.taskProgressFill.style.width = `${(progressPercent * 100).toFixed(1)}%`;
    this.taskProgress.setAttribute('aria-valuenow', String(progressValue));
  }

  setOpsAvailability(connected: boolean): void {
    this.operationsConnected = connected;
    for (const button of Object.values(this.operationButtons)) {
      if (button) button.disabled = !connected;
    }
    this.setOpsStatus(connected ? '' : '未连接');
  }

  setOperationLoading(
    operation: OperationName,
    loading: boolean,
  ): void {
    const button = this.operationButtons[operation];
    if (button) {
      button.disabled = loading || !this.operationsConnected;
      button.setAttribute('aria-busy', String(loading));
    }
  }

  setOpsStatus(text: string): void {
    const el = document.getElementById('ops-status');
    if (el) el.textContent = text;
  }

  setExpeditionTimer(text: string): void {
    this.expeditionTimer.textContent = text;
  }

  setVersion(v: string): void {
    const el = document.getElementById('app-version');
    if (el) el.textContent = v;
  }

  private getButton(id: string): HTMLButtonElement | null {
    return document.getElementById(id) as HTMLButtonElement | null;
  }
}
