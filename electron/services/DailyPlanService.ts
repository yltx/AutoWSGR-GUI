/**
 * 管理演习、战役和决战三类独立日常任务 YAML。
 *
 * 系统计划位于 resource/system_daily_plans，只读。
 * 用户计划位于 Electron userData/user_daily_plans，可覆盖同名系统计划。
 * 本服务只接受 exercise、campaign、decisive，避免它们再次混入普通出征计划。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppPaths } from './AppPaths';
import { AtomicFileStore } from './AtomicFileStore';
import { CombatPlanCodec } from './CombatPlanCodec';
import {
  TaskPresetCodec,
  type TaskPresetDocument,
} from '../../src/shared/taskPreset';
import type {
  DecisivePlanSettings,
} from '../../src/shared/decisivePlan';

export type DailyPlanSource = 'system' | 'user';
export type DailyPlanType = 'exercise' | 'campaign' | 'decisive';

export interface ManagedDailyPlan {
  source: DailyPlanSource;
  file: string;
  name: string;
  taskType: DailyPlanType;
  times: number;
  fleetId?: number;
  campaignName?: string;
  chapter?: number;
  useQuickRepair?: boolean;
}

export interface DailyPlanReadError {
  source: DailyPlanSource;
  file: string;
  message: string;
}

export interface DailyPlanListResult {
  plans: ManagedDailyPlan[];
  errors: DailyPlanReadError[];
}

const DAILY_PLAN_PREFIXES: Readonly<Record<DailyPlanType, string>> = {
  exercise: 'exercise-',
  campaign: 'campaign-',
  decisive: 'decisive-',
};

const DAILY_PLAN_ORDER: Readonly<Record<DailyPlanType, number>> = {
  exercise: 0,
  campaign: 1,
  decisive: 2,
};

/** 提供日常任务计划的受管路径、读取、列表和决战章节保存能力。 */
export class DailyPlanService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly atomicFiles: AtomicFileStore,
    private readonly combatCodec: CombatPlanCodec,
    private readonly taskPresetCodec: TaskPresetCodec,
  ) {}

  /** 列出日常任务；用户同名文件覆盖系统文件。 */
  list(): DailyPlanListResult {
    const plans = new Map<string, ManagedDailyPlan>();
    const errors: DailyPlanReadError[] = [];

    for (const source of ['system', 'user'] as const) {
      for (const file of this.yamlFiles(this.directory(source))) {
        try {
          const plan = this.readPlan(source, file);
          plans.set(file.toLocaleLowerCase(), plan);
        } catch (error) {
          errors.push({
            source,
            file,
            message: error instanceof Error
              ? error.message
              : String(error),
          });
        }
      }
    }

    return {
      plans: [...plans.values()].sort((left, right) => (
        DAILY_PLAN_ORDER[left.taskType]
        - DAILY_PLAN_ORDER[right.taskType]
        || left.name.localeCompare(right.name, 'zh-CN')
      )),
      errors,
    };
  }

  /** 读取一份受管日常任务，并返回任务列表执行所需的 YAML。 */
  read(
    source: DailyPlanSource,
    file: string,
  ): Record<string, unknown> {
    try {
      const filePath = this.safeManagedPath(source, file);
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('日常任务计划不存在');
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      this.parseDailyPlan(content, file);
      return {
        success: true,
        kind: 'daily',
        path: filePath,
        sourcePath: filePath,
        content,
        source,
        file,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 读取指定章节的用户决战配置；没有用户副本时回退到系统配置。 */
  decisivePlan(chapter: number): DecisivePlanSettings {
    const normalizedChapter = this.decisiveChapter(chapter);
    const file = this.decisiveFile(normalizedChapter);
    const userPath = this.safeManagedPath('user', file);
    const source: DailyPlanSource = (
      userPath && fs.existsSync(userPath)
    )
      ? 'user'
      : 'system';
    return this.readDecisiveSettings(source, file);
  }

  /** 读取 GUI 2.0 提供的指定章节系统默认决战配置。 */
  systemDecisivePlan(chapter: number): DecisivePlanSettings {
    const normalizedChapter = this.decisiveChapter(chapter);
    return this.readDecisiveSettings(
      'system',
      this.decisiveFile(normalizedChapter),
    );
  }

  /** 保存一章用户决战配置，其他章节文件保持不变。 */
  saveDecisivePlan(
    settings: DecisivePlanSettings,
  ): DecisivePlanSettings {
    const chapter = this.decisiveChapter(settings.chapter);
    const root = this.taskPresetCodec.normalize({
      task_type: 'decisive',
      chapter,
      times: 1,
      level1: this.shipNames(settings.level1, '主选队列'),
      level2: this.shipNames(settings.level2, '备选队列'),
      use_quick_repair: settings.useQuickRepair === true,
    });
    const directory = this.directory('user');
    fs.mkdirSync(directory, { recursive: true });
    this.atomicFiles.write(
      path.join(directory, this.decisiveFile(chapter)),
      this.combatCodec.serialize(root),
    );
    return this.settingsFromDecisive(root);
  }

  /** 返回系统或用户日常任务目录。 */
  directory(source: DailyPlanSource): string {
    return source === 'system'
      ? this.appPaths.systemDailyPlansDir()
      : this.appPaths.userDailyPlansDir();
  }

  /** 校验文件名并返回受管目录内路径。 */
  safeManagedPath(
    source: DailyPlanSource,
    file: string,
  ): string | null {
    if (
      (source !== 'system' && source !== 'user')
      || path.basename(file) !== file
      || !/^(exercise|campaign|decisive)-.+\.ya?ml$/i.test(file)
    ) {
      return null;
    }
    return path.join(this.directory(source), file);
  }

  private readPlan(
    source: DailyPlanSource,
    file: string,
  ): ManagedDailyPlan {
    const filePath = this.safeManagedPath(source, file);
    if (!filePath) throw new Error('日常任务文件名不符合规则');
    const preset = this.parseDailyPlan(
      fs.readFileSync(filePath, 'utf-8'),
      file,
    );
    const taskType = preset.task_type as DailyPlanType;
    return {
      source,
      file,
      name: this.displayName(file, taskType),
      taskType,
      times: typeof preset.times === 'number' ? preset.times : 1,
      fleetId: typeof preset.fleet_id === 'number'
        ? preset.fleet_id
        : undefined,
      campaignName: typeof preset.campaign_name === 'string'
        ? preset.campaign_name
        : undefined,
      chapter: typeof preset.chapter === 'number'
        ? preset.chapter
        : undefined,
      useQuickRepair: typeof preset.use_quick_repair === 'boolean'
        ? preset.use_quick_repair
        : true,
    };
  }

  private parseDailyPlan(
    content: string,
    file: string,
  ): TaskPresetDocument {
    const root = this.combatCodec.parseRoot(
      content,
      '日常任务计划根节点必须是对象',
    );
    const preset = this.taskPresetCodec.normalize(root);
    if (!this.isDailyPlanType(preset.task_type)) {
      throw new Error(`不支持的日常任务类型：${preset.task_type}`);
    }
    const prefix = DAILY_PLAN_PREFIXES[preset.task_type];
    if (!file.toLocaleLowerCase().startsWith(prefix)) {
      throw new Error(`文件名必须以 ${prefix} 开头`);
    }
    if (preset.task_type === 'decisive') {
      this.decisiveChapter(preset.chapter);
    }
    return preset;
  }

  private readDecisiveSettings(
    source: DailyPlanSource,
    file: string,
  ): DecisivePlanSettings {
    const filePath = this.safeManagedPath(source, file);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`第 ${this.chapterFromFile(file)} 章决战配置不存在`);
    }
    const preset = this.parseDailyPlan(
      fs.readFileSync(filePath, 'utf-8'),
      file,
    );
    if (preset.task_type !== 'decisive') {
      throw new Error('目标文件不是决战配置');
    }
    return this.settingsFromDecisive(preset);
  }

  private settingsFromDecisive(
    preset: TaskPresetDocument,
  ): DecisivePlanSettings {
    return {
      chapter: this.decisiveChapter(preset.chapter),
      useQuickRepair: preset.use_quick_repair !== false,
      level1: this.shipNames(preset.level1, '主选队列'),
      level2: this.shipNames(preset.level2, '备选队列'),
    };
  }

  private isDailyPlanType(value: string): value is DailyPlanType {
    return (
      value === 'exercise'
      || value === 'campaign'
      || value === 'decisive'
    );
  }

  private decisiveChapter(value: unknown): number {
    const chapter = Number(value);
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > 6) {
      throw new Error('决战章节必须是 1 到 6');
    }
    return chapter;
  }

  private shipNames(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) {
      throw new Error(`${label}必须是舰名列表`);
    }
    return value.map((item, index) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`${label}第 ${index + 1} 项不能为空`);
      }
      return item.trim();
    });
  }

  private decisiveFile(chapter: number): string {
    return `decisive-决战第${chapter}章.yaml`;
  }

  private chapterFromFile(file: string): string {
    return /第(\d+)章/.exec(file)?.[1] ?? '?';
  }

  private displayName(file: string, taskType: DailyPlanType): string {
    return file
      .replace(new RegExp(`^${DAILY_PLAN_PREFIXES[taskType]}`, 'i'), '')
      .replace(/\.ya?ml$/i, '');
  }

  private yamlFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter(file => /\.ya?ml$/i.test(file))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }
}
