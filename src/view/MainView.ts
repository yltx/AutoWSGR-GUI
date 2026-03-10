/**
 * MainView —— 主页面纯渲染组件。
 * 绝不包含任何业务逻辑，仅接收 MainViewObject 并更新 DOM。
 */
import type { MainViewObject, LogEntryVO } from './viewObjects';

/** 每种日志级别对应的 SVG 图标 (16x16) */
const LOG_ICONS: Record<string, string> = {
  debug:    '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 1a.5.5 0 0 0-.5.5v1.02a4.5 4.5 0 0 0-1.87 1.16L.94 2.94a.5.5 0 1 0-.38.92l1.2.5A4.5 4.5 0 0 0 1.5 5.5H.5a.5.5 0 0 0 0 1h1.05a4.5 4.5 0 0 0 .55 1.53l-1.16.48a.5.5 0 1 0 .38.92l1.19-.49a4.5 4.5 0 0 0 1.99 1.56v.5a.5.5 0 0 0 1 0v-.16A4.5 4.5 0 0 0 8 11.5a4.5 4.5 0 0 0 2-.44v.44a.5.5 0 0 0 1 0v-.78a4.5 4.5 0 0 0 1.69-1.28l1.19.49a.5.5 0 1 0 .38-.92l-1.16-.48A4.5 4.5 0 0 0 13.5 7h.5a.5.5 0 0 0 0-1h-1a4.5 4.5 0 0 0-.26-1.14l1.2-.5a.5.5 0 1 0-.38-.92l-1.19.74A4.5 4.5 0 0 0 11 2.52V1.5a.5.5 0 0 0-1 0v.68A4.5 4.5 0 0 0 8 1.5a4.5 4.5 0 0 0-2 .68V1.5a.5.5 0 0 0-.5-.5zM8 3a3.5 3.5 0 0 1 3.5 3.5v1A3.5 3.5 0 0 1 8 11a3.5 3.5 0 0 1-3.5-3.5v-1A3.5 3.5 0 0 1 8 3z"/></svg>',
  info:     '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm0 3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM7 7.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v3.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1H8V8h-.5a.5.5 0 0 1-.5-.5z"/></svg>',
  warning:  '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.134 1.503a1 1 0 0 1 1.732 0l6 10.392A1 1 0 0 1 14 13.5H2a1 1 0 0 1-.866-1.5l6-10.497zM8 4.5a.5.5 0 0 0-.5.5v3.5a.5.5 0 0 0 1 0V5a.5.5 0 0 0-.5-.5zm0 6a.625.625 0 1 0 0 1.25.625.625 0 0 0 0-1.25z"/></svg>',
  error:    '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm2.354 3.146a.5.5 0 0 1 0 .708L8.707 8l1.647 1.646a.5.5 0 0 1-.708.708L8 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L7.293 8 5.646 6.354a.5.5 0 0 1 .708-.708L8 7.293l1.646-1.647a.5.5 0 0 1 .708 0z"/></svg>',
  critical: '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm2.354 3.146a.5.5 0 0 1 0 .708L8.707 8l1.647 1.646a.5.5 0 0 1-.708.708L8 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L7.293 8 5.646 6.354a.5.5 0 0 1 .708-.708L8 7.293l1.646-1.647a.5.5 0 0 1 .708 0z"/></svg>',
};

export class MainView {
  private statusDot: HTMLElement;
  private statusText: HTMLElement;
  private expeditionTimer: HTMLElement;
  private taskAreaIdle: HTMLElement;
  private taskAreaQueue: HTMLElement;
  private taskQueueList: HTMLElement;
  private logContainer: HTMLElement;

  /** 日志过滤状态 */
  private logFilterState: Record<string, boolean> = {
    debug: true, info: true, warning: true, error: true, critical: true,
  };
  private logCounts: Record<string, number> = {
    debug: 0, info: 0, warning: 0, error: 0, critical: 0,
  };
  /** 非debug模式下是否丢弃 debug 级别日志 */
  private debugMode = false;

  /** Controller 设置的回调 */
  onRemoveQueueItem?: (taskId: string) => void;
  onMoveQueueItem?: (fromIndex: number, toIndex: number) => void;
  /** 从任务列表拖拽到队列 */
  onDropFromTaskGroup?: (itemIndex: number) => void;
  /** 右键编辑队列任务 */
  onEditQueueItem?: (taskId: string, x: number, y: number) => void;

  constructor() {
    this.statusDot = document.getElementById('status-dot')!;
    this.statusText = document.getElementById('status-text')!;
    this.expeditionTimer = document.getElementById('expedition-timer')!;
    this.taskAreaIdle = document.getElementById('task-area-idle')!;
    this.taskAreaQueue = document.getElementById('task-area-queue')!;
    this.taskQueueList = document.getElementById('task-queue-list')!;
    this.logContainer = document.getElementById('log-container')!;
    this.initLogFilters();
    this.initDropZone();
  }

  /** 初始化任务区域为拖放目标（接受从任务列表拖入的条目） */
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
      // 只在离开 card 本身时移除高亮
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

  /** 接收 ViewObject 并渲染 */
  render(vo: MainViewObject): void {
    // 状态指示器
    this.statusDot.className = `status-indicator ${vo.status}`;
    this.statusText.textContent = vo.statusText;

    // 远征倒计时
    this.expeditionTimer.textContent = vo.expeditionTimer;

    const hasQueue = vo.taskQueue.length > 0;

    if (hasQueue) {
      // 有任务：显示队列视图
      this.taskAreaIdle.style.display = 'none';
      this.taskAreaQueue.style.display = '';

      this.taskQueueList.innerHTML = '';
      const hasRunning = vo.runningTaskId != null;
      for (let i = 0; i < vo.taskQueue.length; i++) {
        const item = vo.taskQueue[i];
        const isRunning = item.id === vo.runningTaskId;
        // queueIndex: index within scheduler queue (excludes running task)
        const queueIndex = hasRunning ? i - 1 : i;
        const div = document.createElement('div');
        div.className = 'task-queue-item' + (isRunning ? ' tq-running' : '');
        div.dataset['queueIndex'] = String(queueIndex);

        // 拖拽排序（非运行中的任务）
        if (!isRunning) {
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

        // 拖拽手柄
        if (!isRunning) {
          const handle = document.createElement('span');
          handle.className = 'tq-drag-handle';
          handle.textContent = '⠿';
          div.appendChild(handle);
        }

        // 进度条背景（仅正在运行的任务）
        if (isRunning && item.progressPercent != null && item.progressPercent > 0) {
          const pct = Math.min(1, Math.max(0, item.progressPercent)) * 100;
          div.style.background = `linear-gradient(90deg, var(--accent-subtle) ${pct}%, transparent ${pct}%)`;
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tq-name';
        nameSpan.textContent = `${item.name} ×${item.remaining}`;
        div.appendChild(nameSpan);

        // 进度文本（仅正在运行的任务）
        if (isRunning && item.progress) {
          const progSpan = document.createElement('span');
          progSpan.className = 'tq-progress';
          progSpan.textContent = item.progress;
          div.appendChild(progSpan);
        }

        const prioSpan = document.createElement('span');
        prioSpan.className = 'tq-priority';
        prioSpan.textContent = item.priorityLabel;
        div.appendChild(prioSpan);

        // 非运行中的任务可以移除
        if (!isRunning) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'tq-remove';
          removeBtn.title = '移除';
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            this.onRemoveQueueItem?.(item.id);
          });
          div.appendChild(removeBtn);
        }

        // 右键菜单
        div.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.onEditQueueItem?.(item.id, e.clientX, e.clientY);
        });

        this.taskQueueList.appendChild(div);
      }

      // 按钮状态
      const startBtn = document.getElementById('btn-start-queue');
      const stopBtn = document.getElementById('btn-stop-task');
      const clearBtn = document.getElementById('btn-clear-queue');
      const isRunningOrStopping = vo.status === 'running' || vo.status === 'stopping';
      if (startBtn) startBtn.style.display = isRunningOrStopping ? 'none' : '';
      if (stopBtn) stopBtn.style.display = isRunningOrStopping ? '' : 'none';
      if (clearBtn) clearBtn.style.display = isRunningOrStopping ? 'none' : '';
    } else {
      // 无任务：显示空闲
      this.taskAreaIdle.style.display = '';
      this.taskAreaQueue.style.display = 'none';
    }
  }

  /** 初始化日志过滤按钮 */
  private initLogFilters(): void {
    const container = document.getElementById('log-filters');
    if (!container) return;
    container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.log-filter-btn') as HTMLElement | null;
      if (!btn) return;
      const level = btn.dataset.level!;
      // 映射：error 按钮同时控制 error + critical
      const levels = level === 'error' ? ['error', 'critical'] : [level];
      const newState = !this.logFilterState[level];
      levels.forEach(l => this.logFilterState[l] = newState);
      btn.classList.toggle('active', newState);
      this.applyLogFilter();
    });
  }

  /** 设置调试模式（非调试模式下过滤掉 debug 级别日志和冗余后端信息） */
  setDebugMode(on: boolean): void {
    this.debugMode = on;
    // 同步 debug 按钮和过滤栏的可见性
    const debugBtn = document.querySelector('.log-filter-btn[data-level="debug"]') as HTMLElement | null;
    if (debugBtn) {
      debugBtn.style.display = on ? '' : 'none';
    }
    // 非调试模式下自动隐藏 debug 级别
    if (!on) {
      this.logFilterState.debug = false;
      this.applyLogFilter();
    } else {
      this.logFilterState.debug = true;
      if (debugBtn) debugBtn.classList.add('active');
      this.applyLogFilter();
    }
  }

  /** 重新遍历日志条目，根据过滤状态显示 / 隐藏 */
  private applyLogFilter(): void {
    const entries = this.logContainer.querySelectorAll('.log-entry');
    entries.forEach(el => {
      const lvl = (el as HTMLElement).dataset.level || '';
      el.classList.toggle('log-hidden', !this.logFilterState[lvl]);
    });
  }

  /** 更新过滤按钮上的计数 badge */
  private updateFilterCount(level: string): void {
    // error 和 critical 合并到 error 按钮
    const countKey = level === 'critical' ? 'error' : level;
    const el = document.getElementById(`log-count-${countKey}`);
    if (!el) return;
    const sum = countKey === 'error'
      ? this.logCounts.error + this.logCounts.critical
      : this.logCounts[countKey] ?? 0;
    el.textContent = sum > 999 ? '999+' : String(sum);
  }

  /** 非调试模式下应过滤掉的冗余信息关键词 */
  private static readonly VERBOSE_PATTERNS = [
    '注册表读取跳过', 'adb kill-server', 'adb start-server',
    'taskkill adb', 'Detector', 'cap_method=',
  ];

  /** 判断日志是否在非调试模式下应被丢弃 */
  private shouldDrop(entry: LogEntryVO): boolean {
    if (this.debugMode) return false;
    if (entry.level === 'debug') return true;
    // 非调试模式下过滤部分后端冗余信息
    if (entry.level === 'info' && entry.channel !== 'GUI') {
      const msg = entry.message;
      for (const pat of MainView.VERBOSE_PATTERNS) {
        if (msg.includes(pat)) return true;
      }
    }
    return false;
  }

  /** 追加一条日志 (增量，不走 render 全量刷新) */
  appendLog(entry: LogEntryVO): void {
    if (this.shouldDrop(entry)) return;

    const level = entry.level || 'info';
    this.logCounts[level] = (this.logCounts[level] || 0) + 1;
    this.updateFilterCount(level);

    const div = document.createElement('div');
    div.className = `log-entry level-${level}`;
    div.dataset.level = level;
    if (!this.logFilterState[level]) div.classList.add('log-hidden');

    const icon = LOG_ICONS[level] || LOG_ICONS.info;
    div.innerHTML =
      `${icon}` +
      `<div class="log-body">` +
        `<div class="log-meta">` +
          `<span class="log-time">${this.esc(entry.time)}</span>` +
          `<span class="log-channel">${this.esc(entry.channel)}</span>` +
        `</div>` +
        `<div class="log-msg">${this.esc(entry.message)}</div>` +
      `</div>`;

    this.logContainer.appendChild(div);

    // 自动滚到底部
    this.logContainer.scrollTop = this.logContainer.scrollHeight;

    // 限制最多保留 500 条；移除时也要减计数
    while (this.logContainer.childElementCount > 500) {
      const first = this.logContainer.firstElementChild as HTMLElement;
      if (first) {
        const oldLevel = first.dataset.level || 'info';
        this.logCounts[oldLevel] = Math.max(0, (this.logCounts[oldLevel] || 0) - 1);
        this.updateFilterCount(oldLevel);
      }
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
