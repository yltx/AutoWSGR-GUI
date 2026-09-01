/**
 * 编排独立编队的保存、加载和列表查询。
 */
import * as path from 'path';
import {
  PlanPresetSource,
  TEAM_FILE_PATTERN,
  TeamPlanCodec,
} from './TeamPlanCodec';
import type { CombatPlanCodec } from './CombatPlanCodec';
import type { CombatPlanRepository } from './CombatPlanRepository';
import { TeamPlanRepository } from './TeamPlanRepository';

interface BattlePlanReferenceUpdate {
  path: string;
  originalContent: string;
  updatedContent: string;
}

/** 编排编队保存、用户选择结果加载和列表查询。 */
export class TeamPlanService {
  constructor(
    private readonly codec: TeamPlanCodec,
    private readonly repository: TeamPlanRepository,
    private readonly combatCodec: CombatPlanCodec,
    private readonly combatRepository: CombatPlanRepository,
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

      let renamedFrom: string | undefined;
      if (
        currentSource === 'user'
        && currentPath
        && !updatesCurrentFile
        && this.repository.exists(currentPath)
      ) {
        const currentPlan = this.repository.read(currentPath);
        if (currentPlan.name !== plan.name) {
          renamedFrom = currentPlan.name;
        }
      }

      const content = this.codec.serialize(plan);
      const referenceUpdates = renamedFrom
        ? this.collectBattlePlanReferenceUpdates(
            renamedFrom,
            plan.name,
          )
        : [];
      const previousTargetContent = this.repository.exists(filePath)
        ? this.repository.readContent(filePath)
        : null;
      const appliedReferenceUpdates: BattlePlanReferenceUpdate[] = [];
      let targetWritten = false;

      try {
        this.repository.write(filePath, content);
        targetWritten = true;
        for (const update of referenceUpdates) {
          this.combatRepository.write(
            update.path,
            update.updatedContent,
          );
          appliedReferenceUpdates.push(update);
        }
        if (
          currentPath
          && currentSource === 'user'
          && !updatesCurrentFile
          && this.repository.exists(currentPath)
        ) {
          this.repository.remove(currentPath);
        }
      } catch (error) {
        for (const update of appliedReferenceUpdates.reverse()) {
          this.combatRepository.write(
            update.path,
            update.originalContent,
          );
        }
        if (targetWritten) {
          if (previousTargetContent !== null) {
            this.repository.write(filePath, previousTargetContent);
          } else if (
            (!currentPath || path.resolve(currentPath).toLowerCase()
              !== path.resolve(filePath).toLowerCase())
            && this.repository.exists(filePath)
          ) {
            this.repository.remove(filePath);
          }
        }
        throw error;
      }

      return {
        success: true,
        file,
        plan: { ...plan, file, source: 'user' },
        renamedFrom,
        updatedBattlePlans: referenceUpdates.length,
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

  /** 收集用户出征计划中需要随编队改名迁移的精确名称引用。 */
  private collectBattlePlanReferenceUpdates(
    oldName: string,
    newName: string,
  ): BattlePlanReferenceUpdate[] {
    const directory = this.combatRepository.directory('user');
    const updates: BattlePlanReferenceUpdate[] = [];
    for (const file of this.combatRepository.yamlFiles(directory)) {
      const filePath = path.join(directory, file);
      const originalContent = this.combatRepository.read(filePath);
      let root: Record<string, unknown>;
      try {
        root = this.combatCodec.parseRoot(
          originalContent,
          '出征计划根节点必须是对象',
        );
      } catch {
        // 损坏且无法解析的计划保持原样，避免一次编队保存改坏其他文件。
        continue;
      }
      if (!Array.isArray(root.fleet_presets)) continue;

      let changed = false;
      const renamedPresets = root.fleet_presets.map(rawPreset => {
        if (
          !this.combatCodec.isPlainObject(rawPreset)
          || typeof rawPreset.name !== 'string'
          || rawPreset.name.trim() !== oldName
        ) {
          return rawPreset;
        }
        changed = true;
        return {
          ...structuredClone(rawPreset),
          name: newName,
        };
      });
      if (!changed) continue;

      let keptRenamedReference = false;
      const deduplicatedPresets = renamedPresets.filter(rawPreset => {
        if (
          !this.combatCodec.isPlainObject(rawPreset)
          || typeof rawPreset.name !== 'string'
          || rawPreset.name.trim() !== newName
        ) {
          return true;
        }
        if (keptRenamedReference) return false;
        keptRenamedReference = true;
        return true;
      });
      const updatedRoot = {
        ...root,
        fleet_presets: deduplicatedPresets,
      };
      updates.push({
        path: filePath,
        originalContent,
        updatedContent: this.combatCodec.serialize(
          updatedRoot,
          originalContent,
        ),
      });
    }
    return updates;
  }
}
