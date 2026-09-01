/**
 * 把 electron-updater 的诊断信息写入独立、限长的文件日志。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'electron-updater';

const MAX_LOG_SIZE = 2 * 1024 * 1024;

/** 优先写入安装目录，权限不足时回退到用户数据目录。 */
export class GuiUpdaterLogger implements Logger {
  private activeLogPath: string | null = null;

  constructor(
    private readonly preferredLogPath: string,
    private readonly fallbackLogPath: string,
  ) {}

  info(message?: unknown): void {
    this.append('INFO', message);
  }

  warn(message?: unknown): void {
    this.append('WARN', message);
  }

  error(message?: unknown): void {
    this.append('ERROR', message);
  }

  debug(message: string): void {
    this.append('DEBUG', message);
  }

  logPath(): string {
    return this.resolveLogPath();
  }

  private append(level: string, value: unknown): void {
    try {
      const logPath = this.resolveLogPath();
      this.rotateIfNeeded(logPath);
      const message = value instanceof Error
        ? value.stack ?? value.message
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
      fs.appendFileSync(
        logPath,
        `${new Date().toISOString()} [${level}] ${message}\n`,
        'utf-8',
      );
    } catch {
      // 更新日志写入失败不能阻断更新或 GUI 启动。
    }
  }

  private resolveLogPath(): string {
    if (this.activeLogPath) return this.activeLogPath;
    for (const candidate of [
      this.preferredLogPath,
      this.fallbackLogPath,
    ]) {
      try {
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.closeSync(fs.openSync(candidate, 'a'));
        this.activeLogPath = candidate;
        return candidate;
      } catch {
        // 继续尝试用户数据目录。
      }
    }
    this.activeLogPath = this.fallbackLogPath;
    return this.activeLogPath;
  }

  private rotateIfNeeded(logPath: string): void {
    try {
      if (
        !fs.existsSync(logPath)
        || fs.statSync(logPath).size < MAX_LOG_SIZE
      ) {
        return;
      }
      const parsed = path.parse(logPath);
      const previous = path.join(
        parsed.dir,
        `${parsed.name}.1${parsed.ext}`,
      );
      fs.rmSync(previous, { force: true });
      fs.renameSync(logPath, previous);
    } catch {
      // 文件正被扫描时继续追加，下一条日志再尝试轮转。
    }
  }
}
