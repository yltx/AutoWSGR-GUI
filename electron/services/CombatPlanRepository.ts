/**
 * 管理系统和用户出征计划文件。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppPaths } from './AppPaths';
import { AtomicFileStore } from './AtomicFileStore';
import { type PlanPresetSource } from './TeamPlanCodec';

/** 负责受管出征计划的路径、读取、写入、重命名和删除。 */
export class CombatPlanRepository {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly atomicFiles: AtomicFileStore,
  ) {}

  /** 初始化用户出征计划目录。 */
  initializeUserDirectory(): void {
    fs.mkdirSync(this.appPaths.userBattlePlansDir(), { recursive: true });
  }

  /** 返回指定来源的权威出征计划目录。 */
  directory(source: PlanPresetSource): string {
    return source === 'system'
      ? this.appPaths.systemBattlePlansDir()
      : this.appPaths.userBattlePlansDir();
  }

  /** 返回经过文件名边界校验的受管计划路径。 */
  safeManagedPath(
    source: PlanPresetSource,
    file: string,
  ): string | null {
    if (
      (source !== 'system' && source !== 'user')
      || path.basename(file) !== file
      || !/\.ya?ml$/i.test(file)
    ) {
      return null;
    }
    return path.join(this.directory(source), file);
  }

  /** 返回经过文件名边界校验的用户计划路径。 */
  safeUserPath(file: string): string | null {
    return this.safeManagedPath('user', file);
  }

  /** 判断绝对路径是否为系统或用户受管计划。 */
  managedFromPath(
    filePath: string,
  ): { source: PlanPresetSource; file: string } | null {
    const resolved = path.resolve(filePath);
    for (const source of ['system', 'user'] as const) {
      const directory = path.resolve(this.directory(source));
      if (
        path.dirname(resolved).toLowerCase() === directory.toLowerCase()
        && /\.ya?ml$/i.test(path.basename(resolved))
      ) {
        return {
          source,
          file: path.basename(resolved),
        };
      }
    }
    return null;
  }

  /** 列出目录中的 YAML 文件并保持既有排序规则。 */
  yamlFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter(file => /\.ya?ml$/i.test(file))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }

  /** 读取一份出征计划原始文本。 */
  read(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  /** 原子写入一份出征计划文本。 */
  write(filePath: string, content: string): void {
    this.atomicFiles.write(filePath, content);
  }

  /** 返回路径是否已存在。 */
  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  /** 返回文件最后修改时间的毫秒值。 */
  modifiedAt(filePath: string): number {
    return fs.statSync(filePath).mtimeMs;
  }

  /** 使用既有文件系统语义重命名计划。 */
  rename(source: string, target: string): void {
    fs.renameSync(source, target);
  }

  /** 删除已有出征计划文件。 */
  remove(filePath: string): void {
    fs.unlinkSync(filePath);
  }
}
