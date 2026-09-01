/**
 * 持久化迁移完成项和最高版本号。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFileStore } from './AtomicFileStore';

/** 当前用户数据迁移状态格式。 */
export interface MigrationState {
  version: number;
  completed: string[];
}

/** 独占管理 .migration-state.json 的解析、合并和原子写入。 */
export class MigrationStateStore {
  constructor(
    private readonly getFilePath: () => string,
    private readonly atomicFiles: AtomicFileStore,
  ) {}

  /** 返回迁移状态文件路径。 */
  filePath(): string {
    return this.getFilePath();
  }

  /** 读取当前迁移状态；无效文件按未迁移处理。 */
  read(): MigrationState {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath(), 'utf-8'),
      ) as Partial<MigrationState>;
      return {
        version: typeof raw.version === 'number' ? raw.version : 0,
        completed: Array.isArray(raw.completed)
          ? raw.completed.filter(value => typeof value === 'string')
          : [],
      };
    } catch {
      return { version: 0, completed: [] };
    }
  }

  /** 原子写入完整迁移状态。 */
  write(state: MigrationState): void {
    fs.mkdirSync(path.dirname(this.filePath()), { recursive: true });
    this.atomicFiles.write(
      this.filePath(),
      JSON.stringify(state, null, 2),
    );
  }

  /** 判断独立迁移阶段是否已经完整成功。 */
  isStageComplete(stage: string): boolean {
    return this.read().completed.includes(stage);
  }

  /** 合并单个阶段完成键，并保留旧迁移记录和较高版本。 */
  completeStage(stage: string, version: number): void {
    this.mergeCompleted([stage], version);
  }

  /** 合并一组完成键，供批量迁移在本轮结束后一次提交。 */
  mergeCompleted(stages: Iterable<string>, version = 0): void {
    const state = this.read();
    const completed = new Set(state.completed);
    for (const stage of stages) completed.add(stage);
    this.write({
      version: Math.max(state.version, version),
      completed: [...completed].sort(),
    });
  }
}
