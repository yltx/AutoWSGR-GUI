/**
 * 管理系统和用户独立编队文件。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AppPaths } from './AppPaths';
import { AtomicFileStore } from './AtomicFileStore';
import {
  PlanFileReadError,
  PlanPresetSource,
  TEAM_FILE_PATTERN,
  TeamPlanCodec,
  UserTeamPlan,
} from './TeamPlanCodec';

export interface TeamPlanWrite {
  name: string;
  file: string;
  path: string;
  content: string;
}

/** 负责独立编队文件的目录、读取、枚举和原子写入。 */
export class TeamPlanRepository {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly atomicFiles: AtomicFileStore,
    private readonly codec: TeamPlanCodec,
  ) {}

  /** 初始化用户编队目录。 */
  initializeUserDirectory(): void {
    fs.mkdirSync(this.appPaths.userTeamPlansDir(), { recursive: true });
  }

  /** 初始化系统编队目录。 */
  initializeSystemDirectory(): void {
    fs.mkdirSync(this.appPaths.systemTeamPlansDir(), { recursive: true });
  }

  /** 返回指定来源的权威编队目录。 */
  directory(source: PlanPresetSource): string {
    return source === 'system'
      ? this.appPaths.systemTeamPlansDir()
      : this.appPaths.userTeamPlansDir();
  }

  /** 读取并归一化一份编队 YAML。 */
  read(filePath: string): UserTeamPlan {
    return this.codec.normalize(
      yaml.load(fs.readFileSync(filePath, 'utf-8')),
    );
  }

  /** 判断磁盘文件的归一化内容是否与计划一致。 */
  matches(filePath: string, plan: UserTeamPlan): boolean {
    if (!fs.existsSync(filePath)) return false;
    try {
      return JSON.stringify(this.read(filePath))
        === JSON.stringify(plan);
    } catch {
      return false;
    }
  }

  /** 为一组计划生成待原子写入的文件列表。 */
  buildWrites(
    teams: UserTeamPlan[],
    directory: string,
  ): TeamPlanWrite[] {
    const files = new Set<string>();
    return teams.map(team => {
      const file = this.codec.fileName(team.name);
      const normalizedFile = file.toLowerCase();
      if (files.has(normalizedFile)) {
        throw new Error(
          `舰队名称生成了重复文件名，请修改名称：${team.name}`,
        );
      }
      files.add(normalizedFile);
      return {
        name: team.name,
        file,
        path: path.join(directory, file),
        content: this.codec.serialize(team),
      };
    });
  }

  /** 原子写入已经序列化的编队内容。 */
  write(filePath: string, content: string): void {
    this.atomicFiles.write(filePath, content);
  }

  /** 返回路径是否已存在。 */
  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  /** 删除已有编队文件。 */
  remove(filePath: string): void {
    fs.unlinkSync(filePath);
  }

  /** 列出系统和用户目录中命名、内容均合法的编队文件。 */
  list(): {
    plans: UserTeamPlan[];
    errors: PlanFileReadError[];
  } {
    const plans: UserTeamPlan[] = [];
    const errors: PlanFileReadError[] = [];
    const sources: Array<{
      directory: string;
      source: PlanPresetSource;
    }> = [
      {
        directory: this.appPaths.systemTeamPlansDir(),
        source: 'system',
      },
      {
        directory: this.appPaths.userTeamPlansDir(),
        source: 'user',
      },
    ];
    for (const { directory, source } of sources) {
      for (const file of this.yamlFiles(directory)) {
        if (!TEAM_FILE_PATTERN.test(file)) {
          errors.push({
            file,
            source,
            kind: 'team',
            message: '舰队文件名必须以 team- 或 team_ 开头',
          });
          continue;
        }
        try {
          const filePath = path.join(directory, file);
          const plan = this.read(filePath);
          plans.push({
            ...plan,
            file,
            modifiedAt: fs.statSync(filePath).mtimeMs,
            source,
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          errors.push({ file, source, kind: 'team', message });
        }
      }
    }
    return { plans, errors };
  }

  /** 查找同来源同名编队，未找到时保持既有跨来源回退。 */
  find(
    name: string,
    source: PlanPresetSource,
    plans = this.list().plans,
  ): UserTeamPlan | null {
    return plans.find(plan => (
      plan.name === name && plan.source === source
    )) ?? plans.find(plan => plan.name === name) ?? null;
  }

  /** 列出目录中的 YAML 文件并保持既有排序规则。 */
  yamlFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter(file => /\.ya?ml$/i.test(file))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }
}
