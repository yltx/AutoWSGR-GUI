/**
 * 编排独立编队的保存、加载和列表查询。
 */
import * as path from 'path';
import {
  PlanPresetSource,
  TEAM_FILE_PATTERN,
  TeamPlanCodec,
} from './TeamPlanCodec';
import { TeamPlanRepository } from './TeamPlanRepository';

/** 编排编队保存、用户选择结果加载和列表查询。 */
export class TeamPlanService {
  constructor(
    private readonly codec: TeamPlanCodec,
    private readonly repository: TeamPlanRepository,
  ) {}

  /** 保存或重命名一份受管编队计划。 */
  save(
    rawPlan: unknown,
    overwrite: boolean,
    currentFile?: string,
    rawSource?: PlanPresetSource,
  ): Record<string, unknown> {
    try {
      const plan = this.codec.normalize(rawPlan);
      const currentSource: PlanPresetSource = rawSource === 'system'
        ? 'system'
        : 'user';
      const directory = this.repository.directory('user');
      const file = this.codec.fileName(plan.name);
      const filePath = path.join(directory, file);
      let currentPath: string | null = null;
      if (currentFile !== undefined) {
        if (
          typeof currentFile !== 'string'
          || path.basename(currentFile) !== currentFile
          || !TEAM_FILE_PATTERN.test(currentFile)
        ) {
          throw new Error('当前编队文件名不符合规则');
        }
        currentPath = path.join(
          this.repository.directory(currentSource),
          currentFile,
        );
      }
      const updatesCurrentFile = currentSource === 'user'
        && currentPath !== null
        && path.resolve(currentPath).toLowerCase()
          === path.resolve(filePath).toLowerCase();
      if (
        this.repository.exists(filePath)
        && !updatesCurrentFile
        && overwrite !== true
      ) {
        return {
          success: false,
          exists: true,
          file,
          error: '存在同名配置',
        };
      }
      const content = this.codec.serialize(plan);
      this.repository.write(filePath, content);
      if (
        currentPath
        && currentSource === 'user'
        && !updatesCurrentFile
        && this.repository.exists(currentPath)
      ) {
        this.repository.remove(currentPath);
      }
      return {
        success: true,
        file,
        plan: { ...plan, file, source: 'user' },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 加载系统文件对话框返回的用户编队路径。 */
  loadSelected(filePathValue: string): Record<string, unknown> {
    const directory = this.repository.directory('user');
    const filePath = path.resolve(filePathValue);
    const file = path.basename(filePath);
    if (
      path.dirname(filePath).toLowerCase()
        !== path.resolve(directory).toLowerCase()
      || !TEAM_FILE_PATTERN.test(file)
    ) {
      return {
        success: false,
        error: '当前yaml格式不符合规则',
      };
    }
    try {
      const plan = this.repository.read(filePath);
      return {
        success: true,
        file,
        plan: { ...plan, file, source: 'user' },
      };
    } catch {
      return {
        success: false,
        error: '当前yaml格式不符合规则',
      };
    }
  }

  /** 列出所有受管编队和逐文件读取错误。 */
  list(): ReturnType<TeamPlanRepository['list']> {
    return this.repository.list();
  }
}
