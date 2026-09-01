/** 渲染任务队列进度并发出删除和停止操作意图。 */
import type { MainViewObject } from '../../types/view.js';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';

function clampPercent(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 统一计算队列和顶栏显示的当前任务进度。 */
export function resolveTaskProgressPercent(
  item: MainViewObject['taskQueue'][number],
  isRunning: boolean,
): number {
  if (!isRunning) return 0;

  // 多轮任务优先按“轮次/总轮次”计算，避免后端单轮 1/1 进度把条形图误显示为 100%。
  if (item.totalTimes > 1) {
    if (item.progress) {
      const parts = item.progress.split('/');
      if (parts.length === 2) {
        const cur = parseInt(parts[0], 10);
        const total = parseInt(parts[1], 10);
        if (Number.isFinite(cur) && Number.isFinite(total) && total > 1) {
          return clampPercent(cur / total);
        }
      }
    }

    const currentRound = item.totalTimes - item.remaining + 1;
    return clampPercent(currentRound / item.totalTimes);
  }

  if (item.progressPercent != null && Number.isFinite(item.progressPercent)) {
    return clampPercent(item.progressPercent);
  }

  if (item.progress) {
    const parts = item.progress.split('/');
    if (parts.length === 2) {
      const cur = parseInt(parts[0], 10);
      const total = parseInt(parts[1], 10);
      if (Number.isFinite(cur) && Number.isFinite(total) && total > 0) {
        return clampPercent(cur / total);
      }
    }
  }

  return 0;
}

export class TaskQueueView {
  private taskAreaIdle: HTMLElement;
  private taskAreaQueue: HTMLElement;
  private taskQueueList: HTMLElement;

  onRemoveQueueItem?: (taskId: string) => void;
  onMoveQueueItem?: (fromIndex: number, toIndex: number) => void;
  onDropFromTaskGroup?: (itemIndex: number) => void;
  onEditQueueItem?: (taskId: string, x: number, y: number) => void;
  onStopTask?: () => void;
  onClearQueue?: () => void;
  onImportPlan?: () => void;
  onStartQueue?: () => void;

  constructor() {
    this.taskAreaIdle = document.getElementById('task-area-idle')!;
    this.taskAreaQueue = document.getElementById('task-area-queue')!;
    this.taskQueueList = document.getElementById('task-queue-list')!;
    this.initDropZone();
    this.bindActions();
  }

  private bindActions(): void {
    document.getElementById('btn-stop-task')?.addEventListener(
      'click',
      () => this.onStopTask?.(),
    );
    document.getElementById('btn-clear-queue')?.addEventListener(
      'click',
      () => this.onClearQueue?.(),
    );
    document.getElementById('btn-import-plan')?.addEventListener(
      'click',
      () => this.onImportPlan?.(),
    );
    document.getElementById('btn-start-queue')?.addEventListener(
      'click',
      () => this.onStartQueue?.(),
    );
  }

  private initDropZone(): void {
    const card = document.getElementById('task-area-card')!;
    card.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-tg-item')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        card.classList.add('drop-highlight');
      }
    });
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget as Node)) {
        card.classList.remove('drop-highlight');
      }
    });
    card.addEventListener('drop', (e) => {
      card.classList.remove('drop-highlight');
      const idxStr = e.dataTransfer?.getData('application/x-tg-item');
      if (idxStr != null && idxStr !== '') {
        e.preventDefault();
        this.onDropFromTaskGroup?.(parseInt(idxStr, 10));
      }
    });
  }

  render(vo: MainViewObject): void {
    const scrollPosition = captureScrollPosition(this.taskQueueList);
    const hasQueue = vo.taskQueue.length > 0;

    if (hasQueue) {
      this.taskAreaIdle.style.display = 'none';
      this.taskAreaQueue.style.display = '';

      this.taskQueueList.innerHTML = '';
      const hasRunning = vo.runningTaskId != null;
      for (let i = 0; i < vo.taskQueue.length; i++) {
        const item = vo.taskQueue[i];
        const isRunning = item.id === vo.runningTaskId;
        const canReorder = !isRunning && !item.waiting;
        const queueIndex = hasRunning ? i - 1 : i;
        const div = document.createElement('div');
        div.className = 'task-queue-item' + (isRunning ? ' tq-running' : '');
        div.dataset['queueIndex'] = String(queueIndex);
        const mainRow = document.createElement('div');
        mainRow.className = 'tq-main-row';

        if (canReorder) {
          div.draggable = true;
          div.addEventListener('dragstart', (e) => {
            div.classList.add('tq-dragging');
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('text/plain', String(queueIndex));
          });
          div.addEventListener('dragend', () => {
            div.classList.remove('tq-dragging');
            this.taskQueueList.querySelectorAll('.tq-drag-over').forEach(el => el.classList.remove('tq-drag-over'));
          });
          div.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'move';
            this.taskQueueList.querySelectorAll('.tq-drag-over').forEach(el => el.classList.remove('tq-drag-over'));
            div.classList.add('tq-drag-over');
          });
          div.addEventListener('dragleave', () => div.classList.remove('tq-drag-over'));
          div.addEventListener('drop', (e) => {
            e.preventDefault();
            div.classList.remove('tq-drag-over');
            const from = parseInt(e.dataTransfer!.getData('text/plain'), 10);
            const to = parseInt(div.dataset['queueIndex']!, 10);
            if (!isNaN(from) && !isNaN(to) && from !== to) {
              this.onMoveQueueItem?.(from, to);
            }
          });
        }

        if (canReorder) {
          const handle = document.createElement('span');
          handle.className = 'tq-drag-handle';
          handle.textContent = '⠿';
          mainRow.appendChild(handle);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tq-name';
        nameSpan.textContent = item.unlimited
          ? `${item.name} ×无限`
          : item.totalTimes > 1
          ? `${item.name} ×${item.totalTimes}`
          : item.name;
        mainRow.appendChild(nameSpan);

        if (isRunning) {
          const progSpan = document.createElement('span');
          progSpan.className = 'tq-progress';
          if (item.unlimited) {
            progSpan.textContent = item.progress || '无限';
          } else if (item.totalTimes > 1) {
            let useBackendProgress = false;
            if (item.progress) {
              const parts = item.progress.split('/');
              if (parts.length === 2) {
                const backendTotal = parseInt(parts[1], 10);
                useBackendProgress = Number.isFinite(backendTotal) && backendTotal > 1;
              }
            }

            if (useBackendProgress && item.progress) {
              progSpan.textContent = item.progress;
            } else {
              const currentRound = item.totalTimes - item.remaining + 1;
              progSpan.textContent = `${currentRound}/${item.totalTimes}`;
            }
          } else if (item.progress) {
            progSpan.textContent = item.progress;
          }
          if (progSpan.textContent) mainRow.appendChild(progSpan);

          if (item.acquisitionText) {
            const acqSpan = document.createElement('span');
            acqSpan.className = 'tq-acquisition';
            acqSpan.textContent = item.acquisitionText;
            mainRow.appendChild(acqSpan);
          }
        } else if (item.waitingText) {
          const waitingSpan = document.createElement('span');
          waitingSpan.className = 'tq-progress';
          waitingSpan.textContent = item.waitingText;
          mainRow.appendChild(waitingSpan);
        }

        const prioSpan = document.createElement('span');
        prioSpan.className = 'tq-priority';
        prioSpan.textContent = item.priorityLabel;
        mainRow.appendChild(prioSpan);

        if (!isRunning) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'tq-remove';
          removeBtn.title = '移除';
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            this.onRemoveQueueItem?.(item.id);
          });
          mainRow.appendChild(removeBtn);
        }

        div.appendChild(mainRow);

        if (isRunning) {
          const pct = resolveTaskProgressPercent(item, isRunning);
          const track = document.createElement('div');
          track.className = 'tq-progress-track';
          const fill = document.createElement('div');
          fill.className = 'tq-progress-fill';
          fill.style.width = `${(pct * 100).toFixed(1)}%`;
          track.appendChild(fill);
          div.appendChild(track);
        }

        div.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.onEditQueueItem?.(item.id, e.clientX, e.clientY);
        });

        this.taskQueueList.appendChild(div);
      }

      const startBtn = document.getElementById('btn-start-queue');
      const stopBtn = document.getElementById(
        'btn-stop-task',
      ) as HTMLButtonElement | null;
      const clearBtn = document.getElementById('btn-clear-queue');
      const isRunningOrStopping = vo.status === 'running' || vo.status === 'stopping';
      const hasReadyTask = vo.taskQueue.some(
        item => !item.waiting && item.id !== vo.runningTaskId,
      );
      if (startBtn) {
        startBtn.style.display = isRunningOrStopping || !hasReadyTask
          ? 'none'
          : '';
      }
      if (stopBtn) {
        const isStopping = vo.status === 'stopping';
        stopBtn.style.display = isRunningOrStopping ? '' : 'none';
        stopBtn.disabled = isStopping;
        stopBtn.classList.toggle('is-stopping', isStopping);
        stopBtn.setAttribute('aria-busy', String(isStopping));
        stopBtn.textContent = isStopping ? '停止中' : '停止任务';
      }
      if (clearBtn) clearBtn.style.display = isRunningOrStopping ? 'none' : '';
    } else {
      this.taskAreaIdle.style.display = '';
      this.taskAreaQueue.style.display = 'none';
    }
    restoreScrollPosition(this.taskQueueList, scrollPosition);
  }
}
