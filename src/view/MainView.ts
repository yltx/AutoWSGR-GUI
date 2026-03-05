/**
 * MainView —— 主页面纯渲染组件。
 * 绝不包含任何业务逻辑，仅接收 MainViewObject 并更新 DOM。
 */
import type { MainViewObject, LogEntryVO } from './viewObjects';

export class MainView {
  private statusDot: HTMLElement;
  private statusText: HTMLElement;
  private taskCard: HTMLElement;
  private taskName: HTMLElement;
  private taskProgress: HTMLElement;
  private idleCard: HTMLElement;
  private expeditionTimer: HTMLElement;
  private taskQueueCard: HTMLElement;
  private taskQueueList: HTMLElement;
  private logContainer: HTMLElement;

  /** Controller 设置的回调 */
  onRemoveQueueItem?: (taskId: string) => void;

  constructor() {
    this.statusDot = document.getElementById('status-dot')!;
    this.statusText = document.getElementById('status-text')!;
    this.taskCard = document.getElementById('current-task-card')!;
    this.taskName = document.getElementById('task-name')!;
    this.taskProgress = document.getElementById('task-progress')!;
    this.idleCard = document.getElementById('idle-card')!;
    this.expeditionTimer = document.getElementById('expedition-timer')!;
    this.taskQueueCard = document.getElementById('task-queue-card')!;
    this.taskQueueList = document.getElementById('task-queue-list')!;
    this.logContainer = document.getElementById('log-container')!;
  }

  /** 接收 ViewObject 并渲染 */
  render(vo: MainViewObject): void {
    // 状态指示器
    this.statusDot.className = `status-indicator ${vo.status}`;
    this.statusText.textContent = vo.statusText;

    // 任务卡片
    if (vo.currentTask) {
      this.taskCard.style.display = '';
      this.idleCard.style.display = 'none';
      this.taskName.textContent = `${vo.currentTask.name} (${vo.currentTask.type})`;
      this.taskProgress.textContent = vo.currentTask.progress;
    } else {
      this.taskCard.style.display = 'none';
      this.idleCard.style.display = '';
    }

    // 远征倒计时
    this.expeditionTimer.textContent = vo.expeditionTimer;

    // 任务队列
    if (vo.taskQueue.length > 0) {
      this.taskQueueCard.style.display = '';
      this.taskQueueList.innerHTML = '';
      for (const item of vo.taskQueue) {
        const div = document.createElement('div');
        div.className = 'task-queue-item';
        div.innerHTML =
          `<span class="tq-name">${this.esc(item.name)} ×${item.remaining}</span>` +
          `<span class="tq-priority">${this.esc(item.priorityLabel)}</span>` +
          `<button class="tq-remove" title="移除">✕</button>`;
        div.querySelector('.tq-remove')!.addEventListener('click', () => {
          this.onRemoveQueueItem?.(item.id);
        });
        this.taskQueueList.appendChild(div);
      }
      // 仅在空闲且有队列时显示「开始执行」按钮
      const startBtn = document.getElementById('btn-start-queue');
      if (startBtn) {
        startBtn.style.display = (vo.status === 'idle' || vo.status === 'not_connected') ? '' : 'none';
      }
    } else {
      this.taskQueueCard.style.display = 'none';
    }
  }

  /** 追加一条日志 (增量，不走 render 全量刷新) */
  appendLog(entry: LogEntryVO): void {
    const div = document.createElement('div');
    div.className = `log-entry level-${entry.level}`;
    div.innerHTML =
      `<span class="log-time">${this.esc(entry.time)}</span>` +
      `<span class="log-channel">[${this.esc(entry.channel)}]</span>` +
      `${this.esc(entry.message)}`;
    this.logContainer.appendChild(div);

    // 自动滚到底部
    this.logContainer.scrollTop = this.logContainer.scrollHeight;

    // 限制最多保留 500 条
    while (this.logContainer.childElementCount > 500) {
      this.logContainer.removeChild(this.logContainer.firstChild!);
    }
  }

  /** 简易 HTML 转义 */
  private esc(s: string): string {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }
}
