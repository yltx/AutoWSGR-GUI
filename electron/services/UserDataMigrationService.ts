/**
 * 迁移旧用户配置并向独立账本登记完成阶段。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { isDeepStrictEqual } from 'util';
import {
  DEFAULT_LOOT_PLAN_ID,
  LEGACY_LOOT_PLAN_IDS,
  lootPlanIdFromIndex,
  lootPlanIdFromLegacyPath,
  migrateLootPlanId,
  parseLootPlanIndex,
  type LootPlanId,
} from '../../src/shared/lootPlans';
import { AppPaths } from './AppPaths';
import { AtomicFileStore } from './AtomicFileStore';
import {
  emptyLegacyMigrationSummary,
  type LegacyMigrationSummary,
} from './LegacyMigrationSummary';
import { MigrationStateStore } from './MigrationStateStore';

/** 持久化保存的最近一次迁移结果。 */
export interface UserDataMigrationReport {
  timestamp: string;
  total: number;
  succeeded: number;
  failed: number;
  failedFiles: string[];
}

/** 旧任务组中的计划路径迁移后所指向的受管配置。 */
export type LegacyPlanReferenceTarget =
  | {
    kind: 'plan';
    file: string;
  }
  | {
    kind: 'daily';
    file: string;
    taskType: 'exercise' | 'campaign' | 'decisive';
  };

/** 用户在旧配置迁移窗口中选择的数据类别。 */
export interface LegacyMigrationSelection {
  dailyPlans: boolean;
  taskQueue: boolean;
  taskYamls: boolean;
}

export const DEFAULT_LEGACY_MIGRATION_SELECTION: Readonly<
LegacyMigrationSelection
> = {
  dailyPlans: true,
  taskQueue: true,
  taskYamls: true,
};

/** 当前旧用户数据迁移版本。 */
export const USER_DATA_MIGRATION_VERSION = 6;

/** v6 库存迁移使用独立完成键，不能只依赖共享版本号。 */
export const PRESET_INVENTORY_MIGRATION_STAGE = (
  'migration:v6:preset-inventory:complete'
);

const OBSOLETE_SYSTEM_PLAN_FILES = new Set([
  'bettle-E1炸鱼.yaml',
  'bettle-E5夜战.yaml',
  'bettle-H1炸鱼.yaml',
  'bettle-H5夜战.yaml',
  'bettle-捞胖次-8-5.yaml',
  'bettle-捞胖次-9-4-6SS.yaml',
  'bettle-周常-1-2-v1.yaml',
  'bettle-周常-3-3-v1.yaml',
  'bettle-周常-6-3-v1.yaml',
]);

const OBSOLETE_SYSTEM_PLAN_ALIASES: Readonly<Record<string, string>> = {
  '活动20260730-E1炸鱼.yaml': 'bettle-E1炸鱼.yaml',
  '活动20260730-E5夜战.yaml': 'bettle-E5夜战.yaml',
  '活动20260730-H1炸鱼.yaml': 'bettle-H1炸鱼.yaml',
  '活动20260730-H5夜战.yaml': 'bettle-H5夜战.yaml',
  'E1炸鱼.yaml': 'bettle-E1炸鱼.yaml',
  'E5夜战.yaml': 'bettle-E5夜战.yaml',
  'H1炸鱼.yaml': 'bettle-H1炸鱼.yaml',
  'H5夜战.yaml': 'bettle-H5夜战.yaml',
  '周常1章-1-2.yaml': 'bettle-周常-1-2-v1.yaml',
  '周常3章-3-3.yaml': 'bettle-周常-3-3-v1.yaml',
  '周常6章-6-3.yaml': 'bettle-周常-6-3-v1.yaml',
};

/** 管理旧配置复制、库存升级和任务组路径更新。 */
export class UserDataMigrationService {
  private legacyMigrationAllowed: boolean | null = null;
  readonly migrationState: MigrationStateStore;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly atomicFiles: AtomicFileStore,
    migrationState?: MigrationStateStore,
  ) {
    this.migrationState = migrationState ?? new MigrationStateStore(
      () => path.join(
        this.appPaths.userDataRoot(),
        '.migration-state.json',
      ),
      atomicFiles,
    );
  }

  /** 判断 EXE 目录是否包含旧版用户数据。 */
  hasLegacyInstallation(): boolean {
    const legacyRoot = this.appPaths.appRoot();
    return [
      'usersettings.yaml',
      'gui_settings.json',
      'task_groups.json',
      'plans',
      'templates',
      path.join('resource', 'user_battle_plans'),
      path.join('resource', 'user_daily_plans'),
      path.join('resource', 'user_team_plans'),
    ].some(relativePath => fs.existsSync(
      path.join(legacyRoot, relativePath),
    ));
  }

  /**
   * 冻结本次启动是否允许迁移当前 EXE 目录。
   *
   * 已初始化 userData 不会因切换安装目录而被旧文件覆盖；同一来源已经开始
   * 但未完成时仍允许重试。
   */
  shouldMigrateLegacyInstallation(): boolean {
    if (this.legacyMigrationAllowed !== null) {
      return this.legacyMigrationAllowed;
    }
    if (!this.hasLegacyInstallation()) {
      this.legacyMigrationAllowed = false;
      return false;
    }

    const state = this.migrationState.read();
    const started = state.completed.includes(
      this.legacySourceStage('started'),
    );
    const completed = state.completed.includes(
      this.legacySourceStage('complete'),
    );
    this.legacyMigrationAllowed = (
      !completed
      && (started || !this.userDataInitialized())
    );
    return this.legacyMigrationAllowed;
  }

  /** 旧设置、任务组和模板阶段是否已经完整成功。 */
  isLegacyConfigurationMigrationComplete(): boolean {
    return this.migrationState.isStageComplete(
      this.legacySourceStage('configuration-complete'),
    );
  }

  /** 在全部迁移阶段和报告均完成后封存当前旧安装来源。 */
  completeLegacySourceMigration(): void {
    if (
      !this.shouldMigrateLegacyInstallation()
      || !this.isLegacyConfigurationMigrationComplete()
    ) {
      return;
    }
    this.migrationState.completeStage(
      this.legacySourceStage('complete'),
      0,
    );
  }

  /** 原子写入最近一次实际迁移报告。 */
  writeMigrationReport(
    summary: LegacyMigrationSummary,
  ): UserDataMigrationReport | null {
    if (!summary.detected || summary.total === 0) return null;
    const report: UserDataMigrationReport = {
      timestamp: new Date().toISOString(),
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      failedFiles: [...summary.failedFiles],
    };
    this.atomicFiles.write(
      this.reportPath(),
      JSON.stringify(report, null, 2),
    );
    return report;
  }

  /** 始终迁移设置，并按用户选择迁移任务队列及其模板。 */
  migrateLegacyUserDataFiles(
    selection: LegacyMigrationSelection = (
      DEFAULT_LEGACY_MIGRATION_SELECTION
    ),
  ): LegacyMigrationSummary {
    const allowed = this.shouldMigrateLegacyInstallation();
    const summary = emptyLegacyMigrationSummary(allowed);
    if (!allowed) return summary;

    this.migrationState.completeStage(
      this.legacySourceStage('started'),
      0,
    );

    const legacyRoot = this.appPaths.appRoot();
    const targetRoot = this.appPaths.userDataRoot();
    for (
      const [file, format] of [
        ['usersettings.yaml', 'yaml'],
        ['gui_settings.json', 'json'],
      ] as const
    ) {
      this.recordResult(
        summary,
        path.join(legacyRoot, file),
        () => this.migrateStructuredFile(
          path.join(legacyRoot, file),
          path.join(targetRoot, file),
          format,
        ),
      );
    }
    this.recordResult(
      summary,
      path.join(targetRoot, 'gui_settings.json'),
      () => this.reconcilePreviouslyMigratedLootPlanSelection(),
    );
    if (selection.taskQueue) {
      this.recordResult(
        summary,
        path.join(legacyRoot, 'task_groups.json'),
        () => this.migrateLegacyTaskGroups(
          path.join(legacyRoot, 'task_groups.json'),
          path.join(targetRoot, 'task_groups.json'),
        ),
      );
      const legacyTemplates = path.join(legacyRoot, 'templates');
      if (fs.existsSync(legacyTemplates)) {
        for (const source of this.regularFiles(legacyTemplates)) {
          this.recordResult(
            summary,
            source,
            () => this.migrateTemplate(
              source,
              path.join(
                targetRoot,
                'templates',
                path.relative(legacyTemplates, source),
              ),
            ),
          );
        }
      }
    }
    if (summary.failed === 0) {
      this.migrationState.completeStage(
        this.legacySourceStage('configuration-complete'),
        0,
      );
    }
    return summary;
  }

  /**
   * 升级 v6 系统预设库存。
   *
   * 已删除且没有等价系统方案的引用会复制为个人计划；旧胖次标识按地图
   * 映射到当前主库计划。迁移只修改 userData，安装资源始终只读。
   */
  migratePresetInventory(): LegacyMigrationSummary {
    if (
      this.migrationState.isStageComplete(
        PRESET_INVENTORY_MIGRATION_STAGE,
      )
    ) {
      return emptyLegacyMigrationSummary();
    }

    const summary = emptyLegacyMigrationSummary();
    const userRoot = this.appPaths.userDataRoot();
    const operations: Array<[string, () => boolean]> = [
      [
        path.join(userRoot, 'gui_settings.json'),
        () => this.migrateStoredLootPlanId(
          path.join(userRoot, 'gui_settings.json'),
          'json',
        ),
      ],
      [
        path.join(userRoot, 'usersettings.yaml'),
        () => this.migrateStoredLootPlanId(
          path.join(userRoot, 'usersettings.yaml'),
          'yaml',
        ),
      ],
      [
        path.join(userRoot, 'task_groups.json'),
        () => this.migrateObsoleteTaskGroupPlans(
          path.join(userRoot, 'task_groups.json'),
        ),
      ],
      [
        path.join(userRoot, 'templates', 'templates.json'),
        () => this.migrateObsoleteTemplatePlans(
          path.join(userRoot, 'templates', 'templates.json'),
        ),
      ],
      [
        path.join(userRoot, 'templates.json'),
        () => this.migrateObsoleteTemplatePlans(
          path.join(userRoot, 'templates.json'),
        ),
      ],
    ];

    for (const [source, operation] of operations) {
      this.recordResult(summary, source, operation);
    }
    summary.detected = summary.total > 0;
    if (summary.failed === 0) {
      this.migrationState.completeStage(
        PRESET_INVENTORY_MIGRATION_STAGE,
        USER_DATA_MIGRATION_VERSION,
      );
    }
    return summary;
  }

  /** 根据旧计划文件名映射更新任务组的受管计划引用。 */
  migrateLegacyTaskGroupPlanPaths(
    fileMap: Map<string, LegacyPlanReferenceTarget>,
  ): void {
    const taskGroupsPath = path.join(
      this.appPaths.userDataRoot(),
      'task_groups.json',
    );
    if (!fs.existsSync(taskGroupsPath) || fileMap.size === 0) return;
    const raw = JSON.parse(
      fs.readFileSync(taskGroupsPath, 'utf-8'),
    ) as Record<string, unknown>;
    if (!Array.isArray(raw.groups)) return;
    let changed = false;
    const groups = raw.groups.map(group => {
      if (!this.isPlainObject(group) || !Array.isArray(group.items)) {
        return group;
      }
      return {
        ...group,
        items: group.items.map(item => {
          if (!this.isPlainObject(item)) return item;
          const oldPath = typeof item.path === 'string' ? item.path : '';
          const oldFile = oldPath.split(/[\\/]/).pop() ?? '';
          const target = fileMap.get(
            this.planReferenceKey(oldPath),
          ) ?? fileMap.get(this.planReferenceKey(oldFile));
          if (!target) return item;
          changed = true;
          const {
            managedSource: _managedSource,
            managedFile: _managedFile,
            dailySource: _dailySource,
            dailyFile: _dailyFile,
            dailyTaskType: _dailyTaskType,
            ...preserved
          } = item;
          if (target.kind === 'daily') {
            return {
              ...preserved,
              kind: 'daily',
              dailySource: 'user',
              dailyFile: target.file,
              dailyTaskType: target.taskType,
              path: oldPath,
            };
          }
          return {
            ...preserved,
            managedSource: 'user',
            managedFile: target.file,
            path: oldPath,
          };
        }),
      };
    });
    if (changed) {
      this.atomicFiles.write(
        taskGroupsPath,
        JSON.stringify({
          ...raw,
          version: 4,
          groups,
        }, null, 2),
      );
    }
  }

  private planReferenceKey(value: string): string {
    const normalized = value
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '');
    return process.platform === 'win32'
      ? normalized.toLowerCase()
      : normalized;
  }

  /** 复制或合并旧任务组，同名但内容不同的组保留为旧版副本。 */
  private migrateLegacyTaskGroups(source: string, target: string): boolean {
    if (!fs.existsSync(source) || this.pathKey(source) === this.pathKey(target)) {
      return false;
    }
    const sourceContent = fs.readFileSync(source, 'utf-8');
    this.parseTaskGroups(sourceContent, '旧任务组');
    const key = this.taskGroupMigrationKey(source, sourceContent);
    if (this.migrationState.isStageComplete(key)) return false;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      this.atomicFiles.write(target, sourceContent);
    } else {
      this.mergeTaskGroupFiles(sourceContent, target);
    }
    this.migrationState.completeStage(key, 0);
    return true;
  }

  private mergeTaskGroupFiles(sourceContent: string, target: string): void {
    const source = this.parseTaskGroups(sourceContent, '旧任务组');
    const targetContent = fs.readFileSync(target, 'utf-8');
    const current = this.parseTaskGroups(targetContent, '当前任务组');
    const groups = [...current.groups];
    let changed = false;

    for (const rawGroup of source.groups) {
      if (!this.isPlainObject(rawGroup)) continue;
      const group = {
        ...rawGroup,
        name: this.taskGroupName(rawGroup),
      };
      const sameName = groups.filter(candidate => (
        this.isPlainObject(candidate)
        && this.taskGroupName(candidate) === group.name
      ));
      if (sameName.some(candidate => this.sameJson(candidate, group))) {
        continue;
      }
      if (sameName.length > 0) {
        group.name = this.uniqueLegacyTaskGroupName(group.name, groups);
      }
      groups.push(group);
      changed = true;
    }
    if (!changed) return;

    const activeGroup = (
      typeof current.activeGroup === 'string'
      && groups.some(group => (
        this.isPlainObject(group)
        && this.taskGroupName(group) === current.activeGroup
      ))
    )
      ? current.activeGroup
      : (
        typeof source.activeGroup === 'string'
          ? source.activeGroup
          : this.firstTaskGroupName(groups)
      );
    this.atomicFiles.write(
      target,
      JSON.stringify({
        ...current,
        version: 1,
        activeGroup,
        groups,
      }, null, 2),
    );
  }

  private parseTaskGroups(
    content: string,
    label: string,
  ): Record<string, unknown> & { groups: unknown[] } {
    const parsed = JSON.parse(content) as unknown;
    if (!this.isPlainObject(parsed) || !Array.isArray(parsed.groups)) {
      throw new Error(`${label}文件格式无效`);
    }
    return {
      ...parsed,
      groups: parsed.groups,
    };
  }

  private taskGroupName(group: Record<string, unknown>): string {
    return typeof group.name === 'string' && group.name.trim()
      ? group.name.trim()
      : '默认';
  }

  private uniqueLegacyTaskGroupName(
    name: string,
    groups: unknown[],
  ): string {
    const usedNames = new Set(groups.flatMap(group => (
      this.isPlainObject(group) ? [this.taskGroupName(group)] : []
    )));
    let candidate = `${name}（旧版）`;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      candidate = `${name}（旧版 ${suffix})`;
      suffix += 1;
    }
    return candidate;
  }

  private firstTaskGroupName(groups: unknown[]): string {
    const first = groups.find(group => this.isPlainObject(group));
    return first && this.isPlainObject(first)
      ? this.taskGroupName(first)
      : '';
  }

  private taskGroupMigrationKey(source: string, content: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');
    return `task-groups-v5:${this.pathKey(source)}:${hash}`;
  }

  private pathKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32'
      ? resolved.toLowerCase()
      : resolved;
  }

  private sameJson(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left, right);
  }

  private reportPath(): string {
    return path.join(
      this.appPaths.userDataRoot(),
      '.migration-report.json',
    );
  }

  private legacySourceStage(
    stage: 'started' | 'configuration-complete' | 'complete',
  ): string {
    const source = this.pathKey(this.appPaths.appRoot());
    const hash = crypto
      .createHash('sha256')
      .update(source)
      .digest('hex');
    return `legacy-source-v5:${hash}:${stage}`;
  }

  /** 只检查 GUI 自有标记，不把 Electron 缓存目录当成用户配置。 */
  private userDataInitialized(): boolean {
    const root = this.appPaths.userDataRoot();
    return [
      this.migrationState.filePath(),
      path.join(root, 'usersettings.yaml'),
      path.join(root, 'gui_settings.json'),
      path.join(root, 'task_groups.json'),
      path.join(root, 'templates.json'),
      path.join(root, 'templates'),
      this.appPaths.userBattlePlansDir(),
      this.appPaths.userDailyPlansDir(),
      this.appPaths.userTeamPlansDir(),
    ].some(candidate => fs.existsSync(candidate));
  }

  private migrateStoredLootPlanId(
    target: string,
    format: 'yaml' | 'json',
  ): boolean {
    const root = this.parseStructuredContent(
      fs.readFileSync(target, 'utf-8'),
      format,
      path.basename(target),
    );
    const automation = format === 'yaml'
      ? root.daily_automation
      : root.automation;
    if (!this.isPlainObject(automation)) return false;
    const key = format === 'yaml' ? 'loot_plan_id' : 'lootPlanId';
    const migrated = migrateLootPlanId(automation[key]);
    if (!migrated || migrated === automation[key]) return false;

    automation[key] = migrated;
    const content = format === 'yaml'
      ? yaml.dump(root, {
        lineWidth: -1,
        noCompatMode: true,
        noRefs: true,
        sortKeys: false,
      })
      : JSON.stringify(root, null, 2);
    this.atomicFiles.write(target, content);
    return true;
  }

  private migrateObsoleteTaskGroupPlans(target: string): boolean {
    const root = this.parseTaskGroups(
      fs.readFileSync(target, 'utf-8'),
      '当前任务组',
    );
    let changed = false;
    const groups = root.groups.map(group => {
      if (!this.isPlainObject(group) || !Array.isArray(group.items)) {
        return group;
      }
      return {
        ...group,
        items: group.items.map(item => {
          if (!this.isPlainObject(item)) return item;
          const file = this.obsoleteSystemPlanFile(item);
          if (!file) return item;
          const userFile = this.preserveObsoleteSystemPlan(file);
          changed = true;
          return {
            ...item,
            managedSource: 'user',
            managedFile: userFile,
          };
        }),
      };
    });
    if (!changed) return false;
    this.atomicFiles.write(
      target,
      JSON.stringify({ ...root, groups }, null, 2),
    );
    return true;
  }

  private migrateObsoleteTemplatePlans(target: string): boolean {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('用户模板文件根节点必须是数组');
    }
    let changed = false;
    const templates = parsed.map(template => {
      if (!this.isPlainObject(template)) return template;
      const output = { ...template };
      if (typeof output.planPath === 'string') {
        const migrated = this.migrateObsoleteTemplatePath(output.planPath);
        if (migrated) {
          output.planPath = migrated;
          changed = true;
        }
      }
      if (Array.isArray(output.planPaths)) {
        output.planPaths = output.planPaths.map(planPath => {
          const migrated = this.migrateObsoleteTemplatePath(planPath);
          if (migrated) changed = true;
          return migrated ?? planPath;
        });
      }
      return output;
    });
    if (!changed) return false;
    this.atomicFiles.write(target, JSON.stringify(templates, null, 2));
    return true;
  }

  private migrateObsoleteTemplatePath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\\/g, '/');
    if (/(?:^|\/)user_battle_plans\//i.test(normalized)) return null;
    const file = this.obsoletePlanFileName(value);
    if (!file) return null;
    return `user_battle_plans/${this.preserveObsoleteSystemPlan(file)}`;
  }

  private obsoleteSystemPlanFile(
    item: Record<string, unknown>,
  ): string | null {
    if (item.managedSource === 'user') return null;
    const pathValue = typeof item.path === 'string' ? item.path : '';
    const isSystemReference = item.managedSource === 'system'
      || /(?:system_battle_plans|builtin_plans|system[\\/])/i.test(pathValue);
    if (!isSystemReference) return null;
    const managedFile = typeof item.managedFile === 'string'
      ? item.managedFile
      : '';
    return this.obsoletePlanFileName(managedFile)
      ?? this.obsoletePlanFileName(pathValue);
  }

  private obsoletePlanFileName(value: string): string | null {
    const file = value.split(/[\\/]/).pop() ?? '';
    const normalized = OBSOLETE_SYSTEM_PLAN_ALIASES[file] ?? file;
    return OBSOLETE_SYSTEM_PLAN_FILES.has(normalized)
      ? normalized
      : null;
  }

  private preserveObsoleteSystemPlan(file: string): string {
    const source = path.join(
      this.appPaths.resourceRoot(),
      'resource',
      'migrations',
      'v6',
      'system_battle_plans',
      file,
    );
    if (!fs.existsSync(source)) {
      throw new Error(`缺少 v6 迁移资源: ${file}`);
    }
    const content = fs.readFileSync(source, 'utf-8');
    const directory = this.appPaths.userBattlePlansDir();
    fs.mkdirSync(directory, { recursive: true });
    const extension = path.extname(file);
    const base = file.slice(0, -extension.length);
    let suffix = 1;
    let candidate = path.join(directory, file);
    while (fs.existsSync(candidate)) {
      if (fs.readFileSync(candidate, 'utf-8') === content) {
        return path.basename(candidate);
      }
      const label = suffix === 1 ? '（旧版）' : `（旧版 ${suffix}）`;
      candidate = path.join(directory, `${base}${label}${extension}`);
      suffix += 1;
    }
    this.atomicFiles.write(candidate, content);
    return path.basename(candidate);
  }

  private migrateStructuredFile(
    source: string,
    target: string,
    format: 'yaml' | 'json',
  ): boolean {
    if (!fs.existsSync(source) || this.pathKey(source) === this.pathKey(target)) {
      return false;
    }
    const sourceContent = fs.readFileSync(source, 'utf-8');
    const key = this.contentMigrationKey(format, source, sourceContent);
    if (this.migrationState.isStageComplete(key)) return false;

    const legacy = this.parseStructuredContent(
      sourceContent,
      format,
      `旧版 ${path.basename(source)}`,
    );
    if (format === 'yaml' && path.basename(source) === 'usersettings.yaml') {
      this.migrateLegacyLootPlanSelection(legacy, source);
    }
    const current = fs.existsSync(target)
      ? this.parseStructuredContent(
        fs.readFileSync(target, 'utf-8'),
        format,
        `当前 ${path.basename(target)}`,
      )
      : {};
    const merged = this.deepMerge(current, legacy);
    const content = format === 'yaml'
      ? yaml.dump(merged, {
        lineWidth: -1,
        noCompatMode: true,
        noRefs: true,
        sortKeys: false,
      })
      : JSON.stringify(merged, null, 2);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.atomicFiles.write(target, content);
    this.migrationState.completeStage(key, 0);
    return true;
  }

  /**
   * 把旧数字索引转换为稳定计划文件名。
   *
   * 完整旧安装优先使用其 builtin_templates.json 解释真实数组顺序；
   * 找不到模板资源时，才按 PR 前四项布局迁移。
   */
  private migrateLegacyLootPlanSelection(
    settings: Record<string, unknown>,
    source: string,
  ): void {
    const daily = settings.daily_automation;
    if (!this.isPlainObject(daily)) return;
    if (typeof daily.loot_plan_id === 'string') return;
    if (
      !Object.prototype.hasOwnProperty.call(daily, 'loot_plan_index')
    ) {
      return;
    }

    const index = parseLootPlanIndex(daily.loot_plan_index);
    if (index === null) {
      daily.loot_plan_id = DEFAULT_LOOT_PLAN_ID;
      daily.auto_loot = false;
      delete daily.loot_plan_index;
      return;
    }
    const resolved = this.resolveLegacyLootPlanId(
      index,
      path.dirname(source),
    );
    daily.loot_plan_id = resolved ?? DEFAULT_LOOT_PLAN_ID;
    if (!resolved) daily.auto_loot = false;
    delete daily.loot_plan_index;
  }

  /**
   * 纠正已由中间版本搬到 GUI JSON、但尚未解释语义的旧索引。
   * 两边索引不一致说明用户后来改过选择，此时保留 GUI JSON 的新布局语义。
   */
  private reconcilePreviouslyMigratedLootPlanSelection(): boolean {
    const legacyRoot = this.appPaths.appRoot();
    const source = path.join(legacyRoot, 'usersettings.yaml');
    const target = path.join(
      this.appPaths.userDataRoot(),
      'gui_settings.json',
    );
    if (!fs.existsSync(source) || !fs.existsSync(target)) return false;

    const settings = this.parseStructuredContent(
      fs.readFileSync(source, 'utf-8'),
      'yaml',
      '旧版 usersettings.yaml',
    );
    const daily = settings.daily_automation;
    if (!this.isPlainObject(daily)) return false;
    const sourceIndex = parseLootPlanIndex(daily.loot_plan_index);
    if (sourceIndex === null) return false;

    const gui = this.parseStructuredContent(
      fs.readFileSync(target, 'utf-8'),
      'json',
      '当前 gui_settings.json',
    );
    const automation = gui.automation;
    if (!this.isPlainObject(automation)) return false;
    if (typeof automation.lootPlanId === 'string') return false;
    const targetIndex = parseLootPlanIndex(automation.lootPlanIndex);
    if (targetIndex === null || sourceIndex !== targetIndex) return false;

    const resolved = this.resolveLegacyLootPlanId(
      sourceIndex,
      legacyRoot,
    );
    const migrated: Record<string, unknown> = {
      ...automation,
      lootPlanId: resolved ?? DEFAULT_LOOT_PLAN_ID,
    };
    delete migrated.lootPlanIndex;
    if (!resolved) migrated.autoLoot = false;
    this.atomicFiles.write(
      target,
      JSON.stringify({ ...gui, automation: migrated }, null, 2),
    );
    return true;
  }

  /** 按旧安装自己的模板顺序解释刷取计划索引。 */
  private resolveLegacyLootPlanId(
    index: number,
    legacyRoot: string,
  ): LootPlanId | null {
    const legacyPaths = this.legacyLootPlanPaths(legacyRoot);
    if (legacyPaths) {
      return lootPlanIdFromLegacyPath(legacyPaths[index]);
    }
    return lootPlanIdFromIndex(index, LEGACY_LOOT_PLAN_IDS);
  }

  /** 读取旧安装自己保存的刷胖次模板顺序。 */
  private legacyLootPlanPaths(legacyRoot: string): unknown[] | null {
    const candidates = [
      path.join(
        legacyRoot,
        'resources',
        'resource',
        'builtin_templates.json',
      ),
      path.join(legacyRoot, 'resource', 'builtin_templates.json'),
    ];
    let templateFileFound = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      templateFileFound = true;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
        if (!Array.isArray(parsed)) continue;
        const template = parsed.find(item => (
          this.isPlainObject(item)
          && item.id === 'builtin_farm_loot'
          && Array.isArray(item.planPaths)
        ));
        if (!this.isPlainObject(template) || !Array.isArray(template.planPaths)) {
          continue;
        }
        return [...template.planPaths];
      } catch {
        // 继续检查另一种旧安装目录结构。
      }
    }
    return templateFileFound ? [] : null;
  }

  private migrateTemplate(source: string, target: string): boolean {
    const content = fs.readFileSync(source);
    const key = this.contentMigrationKey(
      'template',
      source,
      content,
    );
    if (this.migrationState.isStageComplete(key)) return false;

    let destination = target;
    if (
      fs.existsSync(destination)
      && !fs.readFileSync(destination).equals(content)
    ) {
      destination = this.uniqueLegacyPath(destination);
    }
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      this.atomicFiles.write(destination, content.toString('utf-8'));
    }
    this.migrationState.completeStage(key, 0);
    return true;
  }

  private recordResult(
    summary: LegacyMigrationSummary,
    source: string,
    operation: () => boolean,
  ): void {
    if (!fs.existsSync(source)) return;
    try {
      if (!operation()) return;
      summary.total += 1;
      summary.succeeded += 1;
    } catch (error) {
      summary.total += 1;
      summary.failed += 1;
      summary.failedFiles.push(source);
      console.error(`[Migration] ${source} failed:`, error);
    }
  }

  private parseStructuredContent(
    content: string,
    format: 'yaml' | 'json',
    label: string,
  ): Record<string, unknown> {
    const parsed = format === 'yaml'
      ? yaml.load(content)
      : JSON.parse(content);
    if (!this.isPlainObject(parsed)) {
      throw new Error(`${label}根节点必须是对象`);
    }
    return parsed;
  }

  private deepMerge(
    defaults: Record<string, unknown>,
    legacy: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = structuredClone(defaults);
    for (const [key, value] of Object.entries(legacy)) {
      const current = result[key];
      result[key] = this.isPlainObject(current) && this.isPlainObject(value)
        ? this.deepMerge(current, value)
        : structuredClone(value);
    }
    return result;
  }

  private contentMigrationKey(
    kind: string,
    source: string,
    content: string | Buffer,
  ): string {
    const hash = crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');
    return `${kind}-v5:${this.pathKey(source)}:${hash}`;
  }

  private regularFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.regularFiles(target));
      } else if (entry.isFile()) {
        files.push(target);
      }
    }
    return files;
  }

  private uniqueLegacyPath(target: string): string {
    const extension = path.extname(target);
    const base = target.slice(0, -extension.length);
    let candidate = `${base}（旧版）${extension}`;
    let suffix = 2;
    while (fs.existsSync(candidate)) {
      candidate = `${base}（旧版 ${suffix}）${extension}`;
      suffix += 1;
    }
    return candidate;
  }

  private isPlainObject(
    value: unknown,
  ): value is Record<string, unknown> {
    return Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value);
  }
}
