/**
 * 在首次启动时收集旧配置迁移类别。
 */
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
} from 'electron';
import type {
  LegacyMigrationSelection,
} from './UserDataMigrationService';

export interface LegacyMigrationPromptDependencies {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
}

/** 只有明确提交选择时返回结果，直接关闭窗口返回 null。 */
export class LegacyMigrationPrompt {
  constructor(
    private readonly dependencies: LegacyMigrationPromptDependencies,
  ) {}

  show(): Promise<LegacyMigrationSelection | null> {
    return new Promise(resolve => {
      const window = this.dependencies.createWindow({
        width: 500,
        height: 410,
        resizable: false,
        maximizable: false,
        minimizable: false,
        show: false,
        autoHideMenuBar: true,
        title: '旧配置迁移',
        backgroundColor: '#f5f8fc',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      let settled = false;
      const finish = (result: LegacyMigrationSelection | null): void => {
        if (settled) return;
        settled = true;
        resolve(result);
        if (!window.isDestroyed()) window.close();
      };

      window.webContents.on('will-navigate', (event, target) => {
        let url: URL;
        try {
          url = new URL(target);
        } catch {
          event.preventDefault();
          return;
        }
        if (
          url.protocol !== 'legacy-migration:'
          || url.hostname !== 'decision'
        ) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        finish({
          dailyPlans: url.searchParams.get('daily') === '1',
          taskQueue: url.searchParams.get('queue') === '1',
          taskYamls: url.searchParams.get('tasks') === '1',
        });
      });
      window.once('closed', () => finish(null));
      window.once('ready-to-show', () => window.show());
      void window.loadURL(this.pageUrl()).catch(() => finish(null));
    });
  }

  private pageUrl(): string {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>旧配置迁移</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      color: #253349;
      background: linear-gradient(145deg, #f8fbff, #eef4fb);
      font: 14px/1.55 "Microsoft YaHei UI", sans-serif;
    }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 650; }
    .hint { margin: 0 0 16px; color: #5d6b80; }
    .settings {
      margin-bottom: 12px;
      padding: 10px 12px;
      border: 1px solid #d7e2f0;
      border-radius: 8px;
      background: rgba(255, 255, 255, .75);
    }
    .choices {
      display: grid;
      gap: 9px;
      margin-bottom: 20px;
    }
    label {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 10px 12px;
      border: 1px solid #d7e2f0;
      border-radius: 8px;
      background: white;
      cursor: pointer;
    }
    input { margin-top: 3px; accent-color: #367dcc; }
    strong { display: block; font-weight: 650; }
    small { color: #69788d; }
    .actions { display: flex; justify-content: flex-end; gap: 10px; }
    button {
      min-width: 96px;
      padding: 8px 14px;
      border: 1px solid #b7c6d9;
      border-radius: 7px;
      color: #314158;
      background: #fff;
      font: inherit;
      cursor: pointer;
    }
    button.primary { border-color: #367dcc; color: white; background: #367dcc; }
  </style>
</head>
<body>
  <h1>发现旧版配置</h1>
  <p class="hint">请选择要迁移的数据。关闭此窗口不会记录决定，下次启动仍会询问。</p>
  <div class="settings">设置文件会自动迁移，不需要勾选。</div>
  <div class="choices">
    <label>
      <input id="daily" type="checkbox" checked>
      <span><strong>日常任务 YAML</strong><small>演习、战役和决战任务配置</small></span>
    </label>
    <label>
      <input id="queue" type="checkbox" checked>
      <span><strong>任务队列</strong><small>任务组及队列依赖的自定义模板</small></span>
    </label>
    <label>
      <input id="tasks" type="checkbox" checked>
      <span><strong>任务 YAML</strong><small>作战计划及其引用的编队 YAML</small></span>
    </label>
  </div>
  <div class="actions">
    <button id="skip" type="button">不迁移</button>
    <button id="submit" class="primary" type="button">迁移所选</button>
  </div>
  <script>
    const decide = (daily, queue, tasks) => {
      location.href = 'legacy-migration://decision?daily=' + daily
        + '&queue=' + queue + '&tasks=' + tasks;
    };
    document.getElementById('skip').addEventListener('click', () => {
      decide(0, 0, 0);
    });
    document.getElementById('submit').addEventListener('click', () => {
      decide(
        document.getElementById('daily').checked ? 1 : 0,
        document.getElementById('queue').checked ? 1 : 0,
        document.getElementById('tasks').checked ? 1 : 0
      );
    });
  </script>
</body>
</html>`;
    return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
  }
}
