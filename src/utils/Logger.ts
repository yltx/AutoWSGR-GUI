/** 提供统一日志级别、频道和控制台输出格式。 */
/**
 * Logger —— 集中式前端日志工具。
 *
 * 三路输出:
 *   1. 追加写入带时间戳的 .debug.log 文件（始终写入所有级别）
 *   2. 控制台 (console.log / warn / error)
 *   3. UI 日志面板 (通过回调，受"调试模式"控制)
 *
 * 用法:
 *   Logger.init({ appendFile, uiCallback });
 *   Logger.info('消息');
 *   Logger.debug('仅调试模式可见');
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  /** electronBridge.appendFile — 向文件追加写入 */
  appendFile: (path: string, content: string) => Promise<void>;
  /** UI 日志回调 (level, channel, message) */
  uiCallback: (level: string, channel: string, message: string) => void;
  /** 日志文件存放目录（绝对路径） */
  logDir: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function dateTag(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

class LoggerImpl {
  private opts: LoggerOptions | null = null;
  private buffer: string[] = [];

  /** 初始化 Logger（应在 AppController.initAsync 中调用一次） */
  init(opts: LoggerOptions): void {
    this.opts = opts;
    // 定时 flush，避免频繁 IPC
    setInterval(() => this.flush(), 2000);
  }

  info(message: string, channel = 'GUI'): void {
    this.log('info', channel, message);
  }

  debug(message: string, channel = 'GUI'): void {
    this.log('debug', channel, message);
  }

  warn(message: string, channel = 'GUI'): void {
    this.log('warn', channel, message);
  }

  error(message: string, channel = 'GUI'): void {
    this.log('error', channel, message);
  }

  /** 通用方法，level 作为字符串传入 */
  logLevel(level: string, message: string, channel = 'GUI'): void {
    const l = (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as LogLevel;
    this.log(l, channel, message);
  }

  /** 仅写入日志文件和控制台，不推送到 UI 面板（用于原始输出等不适合展示的内容） */
  logToFile(message: string): void {
    this.log('error', 'GUI', message, false);
  }

  /** 手动刷新缓冲区到文件 */
  flush(): void {
    if (!this.opts || this.buffer.length === 0) return;
    const content = this.buffer.join('');
    this.buffer = [];
    const filePath = `${this.opts.logDir}/gui_${dateTag()}.debug.log`;
    this.opts.appendFile(filePath, content).catch(() => {
      // 写入失败不影响运行
    });
  }

  private log(level: LogLevel, channel: string, message: string, showInUi = true): void {
    const ts = formatTimestamp();

    // 1. 文件
    this.buffer.push(`${ts} | ${level.toUpperCase().padEnd(5)} | ${channel} | ${message}\n`);
    // 缓冲区超过 50 条立即 flush
    if (this.buffer.length >= 50) this.flush();

    // 2. 控制台
    const tag = `[${channel}]`;
    switch (level) {
      case 'error': console.error(tag, message); break;
      case 'warn':  console.warn(tag, message);  break;
      case 'debug': console.debug(tag, message); break;
      default:      console.log(tag, message);
    }

    // 3. UI
    if (showInUi) this.opts?.uiCallback(level, channel, message);
  }
}

/** 全局单例 */
export const Logger = new LoggerImpl();
