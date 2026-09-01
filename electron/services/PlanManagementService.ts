/**
 * 编排作战计划的查询、保存和删除。
 */
import * as path from 'path';
import { CombatPlanCodec } from './CombatPlanCodec';
import { CombatPlanRepository } from './CombatPlanRepository';
import { GuiSettingsStore } from './GuiSettingsStore';
import { RuntimePlanService } from './RuntimePlanService';
import {
  type PlanFileReadError,
  type PlanPresetSource,
  TEAM_FILE_PATTERN,
} from './TeamPlanCodec';
import { TeamPlanRepository } from './TeamPlanRepository';
import {
  TaskPresetCodec,
  type TaskPresetType,
} from '../../src/shared/taskPreset';

export type ManagedBattleResult = 'D' | 'C' | 'B' | 'A' | 'S' | 'SS';

export interface ManagedBattlePlanFleetSummary {
  name: string;
  source: PlanPresetSource | 'deleted';
  primaryCount: number;
  backupCount: number;
}

export interface ManagedBattlePlanSummary {
  kind: 'battle' | 'preset';
  file: string;
  name: string;
  source: PlanPresetSource;
  modifiedAt: number;
  chapter: number | string;
  map: number | string;
  times: number;
  gap: number;
  fleetId: number;
  repairMode: number | number[];
  result: ManagedBattleResult | null;
  lootCountGe: number;
  shipCountGe: number;
  fleetCount: number;
  nodeCount: number;
  fleets: ManagedBattlePlanFleetSummary[];
  taskType?: TaskPresetType;
  campaignName?: string;
}

export interface PlanManagementResult {
  bindings: Array<{
    planFile: string;
    planName: string;
    source: PlanPresetSource;
    teamName: string | null;
  }>;
  battlePlans: ManagedBattlePlanSummary[];
  teamPlans: Array<{
    file: string;
    name: string;
    source: PlanPresetSource;
  }>;
  errors: PlanFileReadError[];
  ignoredUnlinkedPlans: string[];
}

interface SaveManagedOptions {
  importEmbeddedTeams?: boolean;
}

/** 编排管理页查询、计划读取、保存、重命名和删除。 */
export class PlanManagementService {
  constructor(
    private readonly combatCodec: CombatPlanCodec,
    private readonly combatRepository: CombatPlanRepository,
    private readonly runtimePlans: RuntimePlanService,
    private readonly teamRepository: TeamPlanRepository,
    private readonly settings: GuiSettingsStore,
    private readonly taskPresetCodec: TaskPresetCodec,
  ) {}

  /** 读取管理页所需的出征计划、舰队方案及名称关联。 */
  get(): PlanManagementResult {
    const bindings: PlanManagementResult['bindings'] = [];
    const battlePlans: ManagedBattlePlanSummary[] = [];
    const errors: PlanFileReadError[] = [];
    const listedTeams = this.teamRepository.list();
    errors.push(...listedTeams.errors);
    const sources: Array<{
      directory: string;
      source: PlanPresetSource;
    }> = [
      {
        directory: this.combatRepository.directory('system'),
        source: 'system',
      },
      {
        directory: this.combatRepository.directory('user'),
        source: 'user',
      },
    ];

    sources.forEach(({ directory, source }) => {
      this.combatRepository.yamlFiles(directory).forEach((file) => {
        try {
          const planPath = path.join(directory, file);
          const root = this.combatCodec.parseRoot(
            this.combatRepository.read(planPath),
            '无效的方案文件',
          );
          const rootName = typeof root.name === 'string'
            ? root.name.trim()
            : '';
          const fileName = file.replace(/\.ya?ml$/i, '');
          const standardName = fileName.match(/^bettle-(.+)$/i)?.[1];
          const planName = standardName || rootName || fileName;
          if (this.taskPresetCodec.isStandalone(root)) {
            const preset = this.taskPresetCodec.normalize(root);
            if (this.isDailyTaskType(preset.task_type)) return;
            const times = Number(preset.times);
            const gap = Number(preset.gap);
            const fleetId = Number(preset.fleet_id);
            battlePlans.push({
              kind: 'preset',
              file,
              name: planName,
              source,
              modifiedAt: this.combatRepository.modifiedAt(planPath),
              chapter: (
                typeof preset.chapter === 'number'
                || typeof preset.chapter === 'string'
              )
                ? preset.chapter
                : '-',
              map: '-',
              times: Number.isFinite(times) && times > 0 ? times : 1,
              gap: Number.isFinite(gap) && gap >= 0 ? gap : 0,
              fleetId: Number.isFinite(fleetId) && fleetId > 0
                ? fleetId
                : 1,
              repairMode: 1,
              result: null,
              lootCountGe: -1,
              shipCountGe: -1,
              fleetCount: 0,
              nodeCount: 0,
              fleets: [],
              taskType: preset.task_type,
              campaignName: typeof preset.campaign_name === 'string'
                ? preset.campaign_name
                : undefined,
            });
            bindings.push({
              planFile: file,
              planName,
              source,
              teamName: null,
            });
            return;
          }
          const presets = Array.isArray(root.fleet_presets)
            ? root.fleet_presets
            : [];
          const selectedNodes = Array.isArray(root.selected_nodes)
            ? root.selected_nodes
            : [];
          const times = Number(root.times);
          const gap = Number(root.gap);
          const fleetId = Number(root.fleet_id);
          const repairModeValue = Number(root.repair_mode);
          const repairModeList = Array.isArray(root.repair_mode)
            ? root.repair_mode
              .map(value => Number(value))
              .filter(value => Number.isFinite(value))
            : [];
          const normalizedResult = typeof root.result === 'string'
            ? root.result.trim().toUpperCase()
            : '';
          const result = (
            ['D', 'C', 'B', 'A', 'S', 'SS'] as ManagedBattleResult[]
          ).includes(normalizedResult as ManagedBattleResult)
            ? normalizedResult as ManagedBattleResult
            : null;
          const stopCondition = this.combatCodec.isPlainObject(
            root.stop_condition,
          )
            ? root.stop_condition
            : {};
          const lootCountGe = Number(stopCondition.loot_count_ge);
          const shipCountGe = Number(stopCondition.ship_count_ge);
          const fleets = presets.flatMap((preset, index) => {
            if (!this.combatCodec.isPlainObject(preset)) return [];
            const name = (
              typeof preset.name === 'string' && preset.name.trim()
            )
              ? preset.name.trim()
              : `编队 ${index + 1}`;
            const userOverride = listedTeams.plans.find(team => (
              team.name === name && team.source === 'user'
            )) ?? null;
            const sameSourceTeam = listedTeams.plans.find(team => (
              team.name === name && team.source === source
            )) ?? null;
            const embeddedShips = Array.isArray(preset.ships)
              ? preset.ships
              : null;
            const matchingPlan = userOverride
              ?? sameSourceTeam
              ?? (embeddedShips
                ? null
                : this.teamRepository.find(
                  name,
                  source,
                  listedTeams.plans,
                ));
            const ships = matchingPlan?.ships ?? embeddedShips ?? [];
            return [{
              name,
              source: (
                matchingPlan?.source ?? 'deleted'
              ) as ManagedBattlePlanFleetSummary['source'],
              primaryCount: ships.filter(ship => (
                (typeof ship === 'string' && Boolean(ship.trim()))
                || (
                  this.combatCodec.isPlainObject(ship)
                  && typeof ship.name === 'string'
                  && Boolean(ship.name.trim())
                )
              )).length,
              backupCount: ships.reduce((count, ship) => (
                count + (
                  this.combatCodec.isPlainObject(ship)
                  && Array.isArray(ship.candidates)
                    ? ship.candidates.length
                    : 0
                )
              ), 0),
            }];
          });
          battlePlans.push({
            kind: 'battle',
            file,
            name: planName,
            source,
            modifiedAt: this.combatRepository.modifiedAt(planPath),
            chapter: (
              typeof root.chapter === 'number'
              || typeof root.chapter === 'string'
            )
              ? root.chapter
              : '?',
            map: (
              typeof root.map === 'number'
              || typeof root.map === 'string'
            )
              ? root.map
              : '?',
            times: Number.isFinite(times) && times > 0 ? times : 1,
            gap: Number.isFinite(gap) && gap >= 0 ? gap : 0,
            fleetId: Number.isFinite(fleetId) && fleetId > 0
              ? fleetId
              : 1,
            repairMode: repairModeList.length > 0
              ? repairModeList
              : Number.isFinite(repairModeValue)
                ? repairModeValue
                : 1,
            result,
            lootCountGe: Number.isFinite(lootCountGe) && lootCountGe > 0
              ? lootCountGe
              : -1,
            shipCountGe: Number.isFinite(shipCountGe) && shipCountGe > 0
              ? shipCountGe
              : -1,
            fleetCount: fleets.length,
            nodeCount: selectedNodes.length,
            fleets,
          });
          if (presets.length === 0) {
            bindings.push({
              planFile: file,
              planName,
              source,
              teamName: null,
            });
            return;
          }
          presets.forEach((preset) => {
            const teamName = this.combatCodec.isPlainObject(preset)
              && typeof preset.name === 'string'
              ? preset.name.trim() || null
              : null;
            bindings.push({
              planFile: file,
              planName,
              source,
              teamName,
            });
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          errors.push({
            file,
            source,
            kind: 'battle',
            message,
          });
        }
      });
    });

    const teamPlans = listedTeams.plans.map(plan => ({
      file: plan.file ?? '',
      name: plan.name,
      source: plan.source ?? 'user',
    }));
    return {
      bindings,
      battlePlans,
      teamPlans,
      errors,
      ignoredUnlinkedPlans: this.getIgnoredUnlinkedPlans(),
    };
  }

  /** 更新一条管理页未关联计划的忽略状态。 */
  setUnlinkedIgnored(
    kind: 'battle' | 'team',
    source: PlanPresetSource,
    file: string,
    ignored: boolean,
  ): string[] {
    const key = this.ignoredUnlinkedPlanKey(kind, source, file);
    if (!key) return this.getIgnoredUnlinkedPlans();
    const values = new Set(this.getIgnoredUnlinkedPlans());
    if (ignored === true) values.add(key);
    else values.delete(key);
    return this.writeIgnoredUnlinkedPlans(values);
  }

  /** 读取一份受管计划，并返回后端执行所需的展开文件。 */
  readManaged(
    source: PlanPresetSource,
    file: string,
  ): Record<string, unknown> {
    try {
      const sourcePath = this.combatRepository.safeManagedPath(source, file);
      if (!sourcePath || !this.combatRepository.exists(sourcePath)) {
        throw new Error('出征计划不存在');
      }
      const originalContent = this.combatRepository.read(sourcePath);
      const root = this.combatCodec.parseRoot(
        originalContent,
        '无效的方案文件',
      );
      if (this.taskPresetCodec.isStandalone(root)) {
        const preset = this.taskPresetCodec.normalize(root);
        if (this.isDailyTaskType(preset.task_type)) {
          throw new Error('该配置属于日常任务，请从“加载日常任务”使用');
        }
        return {
          success: true,
          kind: 'preset',
          path: sourcePath,
          sourcePath,
          content: originalContent,
          source,
        };
      }
      const missingTeamNames = this.missingTeamNames(root, source);
      const prepared = this.runtimePlans.prepare(source, file);
      return {
        success: true,
        kind: 'battle',
        path: prepared.sourcePath,
        sourcePath: prepared.sourcePath,
        runtimePath: prepared.runtimePath,
        content: prepared.content,
        source,
        missingTeamNames,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 读取已经过应用路径边界校验的计划文件。 */
  readResolvedFile(resolved: string): Record<string, unknown> {
    try {
      const managed = this.combatRepository.managedFromPath(resolved);
      if (managed) {
        return this.readManaged(managed.source, managed.file);
      }
      if (!this.combatRepository.exists(resolved)) {
        throw new Error('出征计划不存在');
      }
      return {
        success: true,
        path: resolved,
        sourcePath: resolved,
        content: this.combatRepository.read(resolved),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 把编辑器内容校验并写成后端执行用临时文件。 */
  prepareExecution(
    content: string,
    hint: string,
  ): Record<string, unknown> {
    try {
      if (typeof content !== 'string') {
        throw new Error('出征计划内容不合法');
      }
      return {
        success: true,
        path: this.runtimePlans.write(
          content,
          typeof hint === 'string' ? hint : 'plan',
        ),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 升级用户选择的本地 YAML，并写入用户受管计划目录。 */
  importLocal(
    selectedPath: string,
    overwrite = false,
  ): Record<string, unknown> {
    try {
      if (
        typeof selectedPath !== 'string'
        || !path.isAbsolute(selectedPath)
        || !/\.ya?ml$/i.test(path.basename(selectedPath))
      ) {
        throw new Error('本地出征计划路径不合法');
      }
      if (!this.combatRepository.exists(selectedPath)) {
        throw new Error('本地出征计划不存在');
      }
      return this.saveManaged(
        path.basename(selectedPath),
        this.combatRepository.read(selectedPath),
        overwrite,
        undefined,
        { importEmbeddedTeams: true },
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 保存、覆盖或重命名一份受管出征计划。 */
  saveManaged(
    rawName: string,
    content: string,
    overwrite: boolean,
    currentFile?: string,
    options: SaveManagedOptions = {},
  ): Record<string, unknown> {
    try {
      const name = typeof rawName === 'string'
        ? this.combatCodec.safeBaseName(rawName)
        : '';
      if (!name) throw new Error('请先填写预设名称');
      if (typeof content !== 'string') {
        throw new Error('出征计划内容不合法');
      }
      const parsed = this.combatCodec.parseRoot(
        content,
        '出征计划根节点必须是对象',
      );

      if (this.taskPresetCodec.isStandalone(parsed)) {
        const preset = this.taskPresetCodec.normalize(parsed);
        if (this.isDailyTaskType(preset.task_type)) {
          throw new Error(
            '演习、战役和决战配置请使用“加载日常任务”管理',
          );
        }
        return this.saveManagedTaskPreset(
          name,
          content,
          preset,
          overwrite,
          currentFile,
        );
      }
      const split = this.combatCodec.normalizeFleetPresets(
        parsed,
        'user',
        false,
        !options.importEmbeddedTeams,
      );
      const file = `bettle-${name}.yaml`;
      const target = this.combatRepository.safeUserPath(file);
      if (!target) throw new Error('出征计划名称不合法');
      this.combatRepository.initializeUserDirectory();

      let currentPath: string | null = null;
      if (currentFile !== undefined) {
        currentPath = this.combatRepository.safeUserPath(currentFile);
        if (!currentPath) {
          throw new Error('当前出征计划文件名不符合规则');
        }
      }
      const updatesCurrentFile = currentPath !== null
        && path.resolve(currentPath).toLowerCase()
          === path.resolve(target).toLowerCase();
      const mapConflict = (
        this.combatRepository.exists(target)
        && !updatesCurrentFile
      );
      const teamDirectory = this.teamRepository.directory('user');
      const missingTeamNames = options.importEmbeddedTeams
        ? []
        : this.missingTeamNames(parsed, 'user');
      const missingTeams = new Set(missingTeamNames);
      const parsedPresets = Array.isArray(parsed.fleet_presets)
        ? parsed.fleet_presets
        : null;
      const normalizedPresets = Array.isArray(split.mapRoot.fleet_presets)
        ? split.mapRoot.fleet_presets
        : null;
      const mapRoot = (
        missingTeams.size > 0
        && parsedPresets
        && normalizedPresets
      )
        ? {
            ...split.mapRoot,
            fleet_presets: normalizedPresets.map(
              (reference, index) => {
                const embedded = parsedPresets[index];
                const embeddedName = this.combatCodec.isPlainObject(embedded)
                  && typeof embedded.name === 'string'
                  ? embedded.name.trim()
                  : '';
                return (
                  missingTeams.has(embeddedName)
                  && this.combatCodec.isPlainObject(embedded)
                  && Array.isArray(embedded.ships)
                )
                  ? structuredClone(embedded)
                  : reference;
              },
            ),
          }
        : split.mapRoot;
      const teamWrites = options.importEmbeddedTeams
        ? this.teamRepository.buildWrites(
            split.teams,
            teamDirectory,
          ).map((item, index) => ({
            ...item,
            unchanged: this.teamRepository.matches(
              item.path,
              split.teams[index],
            ),
          }))
        : [];
      const conflicts = [
        ...(mapConflict ? [`地图：${file}`] : []),
        ...teamWrites
          .filter(item => (
            this.teamRepository.exists(item.path) && !item.unchanged
          ))
          .map(item => `舰队：${item.name}`),
      ];
      if (conflicts.length > 0 && overwrite !== true) {
        return {
          success: false,
          exists: true,
          file,
          source: 'user',
          conflicts,
          error: '存在同名配置',
        };
      }

      this.teamRepository.initializeUserDirectory();
      for (const item of teamWrites) {
        if (!item.unchanged) {
          this.teamRepository.write(item.path, item.content);
        }
      }
      this.combatRepository.write(
        target,
        this.combatCodec.serialize(mapRoot, content),
      );
      if (
        currentPath
        && !updatesCurrentFile
        && this.combatRepository.exists(currentPath)
      ) {
        this.combatRepository.remove(currentPath);
      }

      if (currentFile && currentFile !== file) {
        this.moveIgnoredKey('battle', 'user', currentFile, file);
      }
      return {
        success: true,
        kind: 'battle',
        file,
        path: target,
        source: 'user',
        teamFiles: teamWrites.map(item => item.file),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 保存独立任务预设，不把它错误展开成地图计划。 */
  private saveManagedTaskPreset(
    name: string,
    content: string,
    parsed: Record<string, unknown>,
    overwrite: boolean,
    currentFile: string | undefined,
  ): Record<string, unknown> {
    const preset = this.taskPresetCodec.normalize(parsed);
    const file = `bettle-${name}.yaml`;
    const target = this.combatRepository.safeUserPath(file);
    if (!target) throw new Error('任务预设名称不合法');
    this.combatRepository.initializeUserDirectory();

    const currentPath = currentFile === undefined
      ? null
      : this.combatRepository.safeUserPath(currentFile);
    if (currentFile !== undefined && !currentPath) {
      throw new Error('当前任务预设文件名不符合规则');
    }
    const updatesCurrentFile = currentPath !== null
      && path.resolve(currentPath).toLowerCase()
        === path.resolve(target).toLowerCase();
    if (
      this.combatRepository.exists(target)
      && !updatesCurrentFile
      && overwrite !== true
    ) {
      return {
        success: false,
        exists: true,
        kind: 'preset',
        file,
        source: 'user',
        conflicts: [`任务预设：${file}`],
        error: '存在同名配置',
      };
    }

    this.combatRepository.write(
      target,
      this.combatCodec.serialize(preset, content),
    );
    if (
      currentPath
      && !updatesCurrentFile
      && this.combatRepository.exists(currentPath)
    ) {
      this.combatRepository.remove(currentPath);
    }
    if (currentFile && currentFile !== file) {
      this.moveIgnoredKey('battle', 'user', currentFile, file);
    }
    return {
      success: true,
      kind: 'preset',
      file,
      path: target,
      source: 'user',
      teamFiles: [],
    };
  }

  /** 重命名一份用户出征计划。 */
  renameUser(
    file: string,
    newName: string,
  ): Record<string, unknown> {
    const source = this.combatRepository.safeUserPath(file);
    const safeName = this.combatCodec.safeBaseName(newName);
    if (
      !source
      || !this.combatRepository.exists(source)
      || !safeName
    ) {
      return { success: false, error: '出征计划名称或文件不合法' };
    }
    const targetFile = `bettle-${safeName}.yaml`;
    const target = this.combatRepository.safeUserPath(targetFile);
    if (!target) {
      return { success: false, error: '出征计划名称不合法' };
    }
    if (
      source.toLowerCase() !== target.toLowerCase()
      && this.combatRepository.exists(target)
    ) {
      return { success: false, error: '同名出征计划已存在' };
    }
    try {
      this.combatRepository.rename(source, target);
      this.moveIgnoredKey('battle', 'user', file, targetFile);
      return { success: true, file: targetFile };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 删除一份用户出征计划。 */
  deleteUserCombat(file: string): Record<string, unknown> {
    const target = this.combatRepository.safeUserPath(file);
    if (!target || !this.combatRepository.exists(target)) {
      return { success: false, error: '用户出征计划不存在' };
    }
    try {
      this.combatRepository.remove(target);
      this.removeIgnoredKey('battle', 'user', file);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 删除一份用户独立编队计划。 */
  deleteUserTeam(file: string): Record<string, unknown> {
    const target = this.safeManagedTeamPath('user', file);
    if (!target || !this.teamRepository.exists(target)) {
      return { success: false, error: '用户舰队方案不存在' };
    }
    try {
      this.teamRepository.remove(target);
      this.removeIgnoredKey('team', 'user', file);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 返回计划引用但编队管理中不存在的编队名称。 */
  private missingTeamNames(
    root: Record<string, unknown>,
    source: PlanPresetSource,
  ): string[] {
    if (!Array.isArray(root.fleet_presets)) return [];
    const plans = this.teamRepository.list().plans;
    const names = root.fleet_presets.flatMap((preset) => {
      if (
        !this.combatCodec.isPlainObject(preset)
        || typeof preset.name !== 'string'
      ) {
        return [];
      }
      const name = preset.name.trim();
      return (
        name
        && !this.teamRepository.find(name, source, plans)
      )
        ? [name]
        : [];
    });
    return [...new Set(names)];
  }

  /** 读取并兼容旧格式的未关联忽略项。 */
  private getIgnoredUnlinkedPlans(): string[] {
    const raw = this.settings.read().plan_management_ignored_unlinked;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
      if (typeof value !== 'string') return [];
      if (
        /^(battle|team)\/(system|user)\/[^/\\]+\.ya?ml$/i.test(value)
      ) {
        return [value];
      }
      const legacy = /^(system|user)\/([^/\\]+\.ya?ml)$/i.exec(value);
      return legacy ? [`battle/${legacy[1]}/${legacy[2]}`] : [];
    });
  }

  /** 去重、排序并保存未关联忽略项。 */
  private writeIgnoredUnlinkedPlans(values: Iterable<string>): string[] {
    const normalized = [...new Set(values)].sort((left, right) => (
      left.localeCompare(right, 'zh-CN')
    ));
    this.settings.write({
      plan_management_ignored_unlinked: normalized,
    });
    return normalized;
  }

  /** 为有效的受管计划构造稳定忽略键。 */
  private ignoredUnlinkedPlanKey(
    kind: 'battle' | 'team',
    source: PlanPresetSource,
    file: string,
  ): string | null {
    const valid = kind === 'battle'
      ? this.combatRepository.safeManagedPath(source, file)
      : this.safeManagedTeamPath(source, file);
    return valid ? `${kind}/${source}/${file}` : null;
  }

  /** 返回经过文件名边界校验的受管编队路径。 */
  private safeManagedTeamPath(
    source: PlanPresetSource,
    file: string,
  ): string | null {
    if (
      (source !== 'system' && source !== 'user')
      || path.basename(file) !== file
      || !TEAM_FILE_PATTERN.test(file)
    ) {
      return null;
    }
    return path.join(this.teamRepository.directory(source), file);
  }

  /** 在计划重命名后同步迁移对应忽略键。 */
  private moveIgnoredKey(
    kind: 'battle' | 'team',
    source: PlanPresetSource,
    oldFile: string,
    newFile: string,
  ): void {
    const oldKey = this.ignoredUnlinkedPlanKey(kind, source, oldFile);
    const newKey = this.ignoredUnlinkedPlanKey(kind, source, newFile);
    const ignored = new Set(this.getIgnoredUnlinkedPlans());
    if (oldKey && newKey && ignored.delete(oldKey)) {
      ignored.add(newKey);
      this.writeIgnoredUnlinkedPlans(ignored);
    }
  }

  /** 删除计划后同步清理对应忽略键。 */
  private removeIgnoredKey(
    kind: 'battle' | 'team',
    source: PlanPresetSource,
    file: string,
  ): void {
    const key = this.ignoredUnlinkedPlanKey(kind, source, file);
    if (!key) return;
    const ignored = new Set(this.getIgnoredUnlinkedPlans());
    if (ignored.delete(key)) {
      this.writeIgnoredUnlinkedPlans(ignored);
    }
  }

  private isDailyTaskType(value: unknown): boolean {
    return (
      value === 'exercise'
      || value === 'campaign'
      || value === 'decisive'
    );
  }
}
