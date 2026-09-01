/**
 * 读取并浅合并写入 gui_settings.json。
 */
import * as fs from 'fs';
import { AtomicFileStore } from './AtomicFileStore';

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

/** 管理唯一 GUI JSON 设置文件的读取和浅合并写入。 */
export class GuiSettingsStore {
  constructor(
    private readonly getFilePath: () => string,
    private readonly atomicFiles: AtomicFileStore,
  ) {}

  /** 返回当前 GUI 设置文件路径。 */
  filePath(): string {
    return this.getFilePath();
  }

  /** 读取设置；不存在或无法解析时保持原有空对象回退。 */
  read(): Record<string, unknown> {
    try {
      return this.readCurrent();
    } catch {
      // 文件缺失或无效时返回空设置。
      return {};
    }
  }

  /** 浅合并 patch 后覆盖写回唯一设置文件。 */
  write(patch: Record<string, unknown>): void {
    const current = this.readCurrent();
    Object.assign(current, patch);
    this.atomicFiles.write(
      this.filePath(),
      JSON.stringify(current, null, 2),
    );
  }

  /**
   * 写入路径必须区分“不存在”和“已有但损坏”，避免用局部 patch
   * 覆盖无法解析的完整配置。
   */
  private readCurrent(): Record<string, unknown> {
    const filePath = this.filePath();
    if (!fs.existsSync(filePath)) return {};
    const parsed: unknown = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    );
    if (!isRecord(parsed)) {
      throw new Error('gui_settings.json 根节点必须是对象');
    }
    return parsed;
  }
}
