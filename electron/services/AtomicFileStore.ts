/**
 * 通过同目录临时文件和原子替换完成持久化写入。
 */
import * as fs from 'fs';

const WINDOWS_RETRY_DELAYS_MS = [20, 50, 100];
const WINDOWS_TRANSIENT_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

/** 为需要失败回滚的持久化模块提供统一写入能力。 */
export class AtomicFileStore {
  /** 把文本或二进制内容写入目标文件，并在失败时保留原文件。 */
  write(filePath: string, content: string | Uint8Array): void {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      this.retryWindowsFileLock(() => {
        if (typeof content === 'string') {
          fs.writeFileSync(temporary, content, 'utf-8');
        } else {
          fs.writeFileSync(temporary, content);
        }
      });
      this.retryWindowsFileLock(() => {
        fs.renameSync(temporary, filePath);
      });
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // 清理失败不能覆盖最初的替换错误。
      }
      throw error;
    }
  }

  /** Windows 文件扫描或短暂占用时，等待后重试文件操作。 */
  private retryWindowsFileLock(operation: () => void): void {
    for (let attempt = 0; ; attempt += 1) {
      try {
        operation();
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const delay = WINDOWS_RETRY_DELAYS_MS[attempt];
        if (
          process.platform !== 'win32'
          || !code
          || !WINDOWS_TRANSIENT_CODES.has(code)
          || delay === undefined
        ) {
          throw error;
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          delay,
        );
      }
    }
  }
}
