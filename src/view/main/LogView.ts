/** 追加、筛选并滚动展示运行日志。 */
import type { LogEntryVO } from '../../types/view.js';

/** 每种日志级别对应的 SVG 图标 (16x16) */
const LOG_ICONS: Record<string, string> = {
  debug:    '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 1a.5.5 0 0 0-.5.5v1.02a4.5 4.5 0 0 0-1.87 1.16L.94 2.94a.5.5 0 1 0-.38.92l1.2.5A4.5 4.5 0 0 0 1.5 5.5H.5a.5.5 0 0 0 0 1h1.05a4.5 4.5 0 0 0 .55 1.53l-1.16.48a.5.5 0 1 0 .38.92l1.19-.49a4.5 4.5 0 0 0 1.99 1.56v.5a.5.5 0 0 0 1 0v-.16A4.5 4.5 0 0 0 8 11.5a4.5 4.5 0 0 0 2-.44v.44a.5.5 0 0 0 1 0v-.78a4.5 4.5 0 0 0 1.69-1.28l1.19.49a.5.5 0 1 0 .38-.92l-1.16-.48A4.5 4.5 0 0 0 13.5 7h.5a.5.5 0 0 0 0-1h-1a4.5 4.5 0 0 0-.26-1.14l1.2-.5a.5.5 0 1 0-.38-.92l-1.19.74A4.5 4.5 0 0 0 11 2.52V1.5a.5.5 0 0 0-1 0v.68A4.5 4.5 0 0 0 8 1.5a4.5 4.5 0 0 0-2 .68V1.5a.5.5 0 0 0-.5-.5zM8 3a3.5 3.5 0 0 1 3.5 3.5v1A3.5 3.5 0 0 1 8 11a3.5 3.5 0 0 1-3.5-3.5v-1A3.5 3.5 0 0 1 8 3z"/></svg>',
  info:     '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm0 3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM7 7.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v3.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1H8V8h-.5a.5.5 0 0 1-.5-.5z"/></svg>',
  warning:  '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.134 1.503a1 1 0 0 1 1.732 0l6 10.392A1 1 0 0 1 14 13.5H2a1 1 0 0 1-.866-1.5l6-10.497zM8 4.5a.5.5 0 0 0-.5.5v3.5a.5.5 0 0 0 1 0V5a.5.5 0 0 0-.5-.5zm0 6a.625.625 0 1 0 0 1.25.625.625 0 0 0 0-1.25z"/></svg>',
  error:    '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm2.354 3.146a.5.5 0 0 1 0 .708L8.707 8l1.647 1.646a.5.5 0 0 1-.708.708L8 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L7.293 8 5.646 6.354a.5.5 0 0 1 .708-.708L8 7.293l1.646-1.647a.5.5 0 0 1 .708 0z"/></svg>',
  critical: '<svg class="log-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm2.354 3.146a.5.5 0 0 1 0 .708L8.707 8l1.647 1.646a.5.5 0 0 1-.708.708L8 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L7.293 8 5.646 6.354a.5.5 0 0 1 .708-.708L8 7.293l1.646-1.647a.5.5 0 0 1 .708 0z"/></svg>',
};

export class LogView {
  private logContainer: HTMLElement;

  private logFilterState: Record<string, boolean> = {
    debug: true, info: true, warning: true, error: true, critical: true,
  };
  private logCounts: Record<string, number> = {
    debug: 0, info: 0, warning: 0, error: 0, critical: 0,
  };
  private debugMode = false;

  private static readonly VERBOSE_PATTERNS = [
    '注册表读取跳过', 'adb kill-server', 'adb start-server',
    'taskkill adb', 'Detector', 'cap_method=',
  ];

  constructor() {
    this.logContainer = document.getElementById('log-container')!;
    this.initLogFilters();
  }

  private initLogFilters(): void {
    const container = document.getElementById('log-filters');
    if (!container) return;
    container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.log-filter-btn') as HTMLElement | null;
      if (!btn) return;
      const level = btn.dataset.level!;
      const levels = level === 'error' ? ['error', 'critical'] : [level];
      const newState = !this.logFilterState[level];
      levels.forEach(l => this.logFilterState[l] = newState);
      btn.classList.toggle('active', newState);
      this.applyLogFilter();
    });
  }

  setDebugMode(on: boolean): void {
    this.debugMode = on;
    const debugBtn = document.querySelector('.log-filter-btn[data-level="debug"]') as HTMLElement | null;
    if (debugBtn) {
      debugBtn.style.display = on ? '' : 'none';
    }
    if (!on) {
      this.logFilterState.debug = false;
      this.applyLogFilter();
    } else {
      this.logFilterState.debug = true;
      if (debugBtn) debugBtn.classList.add('active');
      this.applyLogFilter();
    }
  }

  private applyLogFilter(): void {
    const entries = this.logContainer.querySelectorAll('.log-entry');
    entries.forEach(el => {
      const lvl = (el as HTMLElement).dataset.level || '';
      el.classList.toggle('log-hidden', !this.logFilterState[lvl]);
    });
  }

  private updateFilterCount(level: string): void {
    const countKey = level === 'critical' ? 'error' : level;
    const el = document.getElementById(`log-count-${countKey}`);
    if (!el) return;
    const sum = countKey === 'error'
      ? this.logCounts.error + this.logCounts.critical
      : this.logCounts[countKey] ?? 0;
    el.textContent = sum > 999 ? '999+' : String(sum);
  }

  private shouldDrop(entry: LogEntryVO): boolean {
    if (this.debugMode) return false;
    if (entry.level === 'debug') return true;
    if (entry.level === 'info' && entry.channel !== 'GUI') {
      const msg = entry.message;
      for (const pat of LogView.VERBOSE_PATTERNS) {
        if (msg.includes(pat)) return true;
      }
    }
    return false;
  }

  appendLog(entry: LogEntryVO): void {
    if (this.shouldDrop(entry)) return;

    const level = entry.level || 'info';
    this.logCounts[level] = (this.logCounts[level] || 0) + 1;
    this.updateFilterCount(level);

    const div = document.createElement('div');
    div.className = `log-entry level-${level}`;
    div.dataset.level = level;
    if (entry.message.startsWith('[UI]')) div.classList.add('log-ui-recognition');
    if (entry.message.includes('迂回')) div.classList.add('log-detour');
    if (entry.message.includes('掉落')) div.classList.add('log-ship-drop');
    if (!this.logFilterState[level]) div.classList.add('log-hidden');

    const icon = LOG_ICONS[level] || LOG_ICONS.info;
    let msgHtml = this.esc(entry.message);
    msgHtml = msgHtml.replace(/评价=(SS|S|A|B|C|D)\b/, (_, g) => {
      const cls = g === 'SS' ? 'grade-ss' : g === 'S' ? 'grade-s' : g === 'A' ? 'grade-a' : 'grade-low';
      return `评价=<span class="log-grade ${cls}">${g}</span>`;
    });
    msgHtml = msgHtml.replace(/MVP[:：]\s*(.+?)(?=\s*[,，|]|$)/, (_match, name) => {
      return `<span class="log-mvp">MVP: ${name}</span>`;
    });
    msgHtml = msgHtml.replace(/掉落[:：]\s*(.+?)(?=\s*$)/, (_match, name) => {
      return `掉落: <span class="log-ship-drop-name">${name}</span>`;
    });

    div.innerHTML =
      `${icon}` +
      `<div class="log-body">` +
        `<div class="log-meta">` +
          `<span class="log-time">${this.esc(entry.time)}</span>` +
          `<span class="log-channel">${this.esc(entry.channel)}</span>` +
        `</div>` +
        `<div class="log-msg">${msgHtml}</div>` +
      `</div>`;

    this.logContainer.appendChild(div);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;

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

  private esc(s: string): string {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }
}
