/**
 * 管理旧配置迁移后需要用户确认的 YAML 冲突。
 *
 * 处理流程：
 * 1. 迁移结束后扫描系统与用户受管目录。
 * 2. YAML 先解析为结构化数据，再比较内容是否完全一致。
 * 3. 同名异内容和迁移生成的“旧版”副本也作为冲突原因记录。
 * 4. 待处理清单写入 userData，关闭窗口不会丢失确认任务。
 * 5. Renderer 只获得冲突 ID、文件名和原因，不获得绝对路径。
 * 6. 用户提交的是保留 ID；其余文件才进入删除候选。
 * 7. 删除前再次校验文件名、文件类型和内容哈希。
 * 8. 内容已变化的文件不会删除，并留到下次继续处理。
 * 9. 与系统预设完全相同的文件删除前会重写任务列表和自动胖次引用。
 * 10. 同名异内容没有安全替代项，只按用户明确选择删除。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import type {
  MigrationConflictItem,
  MigrationConflictKind,
  MigrationConflictListResult,
  MigrationConflictReason,
  MigrationConflictResolutionResult,
} from '../../src/shared/migrationConflicts';
import { parseYaml } from '../../src/shared/yamlSerializer';
import { AppPaths } from './AppPaths';
import { AtomicFileStore } from './AtomicFileStore';

const MIGRATION_CONFLICT_STATE_VERSION = 1;

interface StoredMigrationConflict extends MigrationConflictItem {
  contentHash: string;
  systemReplacement?: string;
}

interface MigrationConflictState {
  version: number;
  status: 'pending' | 'resolved';
  conflicts: StoredMigrationConflict[];
  acceptedIds: string[];
}

interface ParsedYamlFile {
  file: string;
  value: unknown;
}

/** 检测、持久化并安全处理迁移产生的用户 YAML 冲突。 */
export class MigrationConflictService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly atomicFiles: AtomicFileStore,
  ) {}

  /**
   * 应用升级到该功能后至少扫描一次；本次实际发生迁移时强制重扫。
   */
  prepareAfterMigration(forceScan: boolean): void {
    const current = this.readState();
    if (current && !forceScan) return;
    const acceptedIds = current?.acceptedIds ?? [];
    const accepted = new Set(acceptedIds);
    const conflicts = this.detectConflicts().filter(conflict => (
      !accepted.has(conflict.id)
    ));
    this.writeState({
      version: MIGRATION_CONFLICT_STATE_VERSION,
      status: conflicts.length > 0 ? 'pending' : 'resolved',
      conflicts,
      acceptedIds,
    });
  }

  /** 返回仍存在且内容未变化的待处理文件。 */
  pending(): MigrationConflictListResult {
    const state = this.readState();
    if (!state || state.status !== 'pending') {
      return { pending: false, conflicts: [] };
    }
    const conflicts = state.conflicts.filter(conflict => (
      this.conflictFileStillMatches(conflict)
    ));
    if (conflicts.length !== state.conflicts.length) {
      this.writeState({
        ...state,
        status: conflicts.length > 0 ? 'pending' : 'resolved',
        conflicts,
      });
    }
    return {
      pending: conflicts.length > 0,
      conflicts: conflicts.map(conflict => this.publicConflict(conflict)),
    };
  }

  /**
   * 保留 keepIds 中的文件，删除其余待处理文件。
   *
   * 删除目标始终由持久化冲突记录反查，Renderer 不能传入路径。
   */
  resolve(keepIds: unknown): MigrationConflictResolutionResult {
    const state = this.readState();
    if (!state || state.status !== 'pending') {
      return {
        success: true,
        kept: 0,
        deleted: 0,
        errors: [],
        remaining: [],
      };
    }
    if (!Array.isArray(keepIds) || keepIds.some(id => (
      typeof id !== 'string'
    ))) {
      throw new Error('保留清单格式无效');
    }
    const knownIds = new Set(state.conflicts.map(conflict => conflict.id));
    const keep = new Set(keepIds as string[]);
    if ([...keep].some(id => !knownIds.has(id))) {
      throw new Error('保留清单包含未知冲突项');
    }

    const kept = state.conflicts.filter(conflict => keep.has(conflict.id));
    const requestedDeletes = state.conflicts.filter(conflict => (
      !keep.has(conflict.id)
    ));
    const validDeletes: StoredMigrationConflict[] = [];
    const remaining: StoredMigrationConflict[] = [];
    const errors: string[] = [];

    for (const conflict of requestedDeletes) {
      if (this.conflictFileStillMatches(conflict)) {
        validDeletes.push(conflict);
      } else {
        remaining.push(conflict);
        errors.push(`${conflict.file} 已变化，未执行删除`);
      }
    }

    try {
      this.rewriteTaskGroupReferences(validDeletes);
      this.rewriteAutomationReferences(validDeletes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`配置引用更新失败：${message}`);
      remaining.push(...validDeletes);
      validDeletes.length = 0;
    }

    let deleted = 0;
    for (const conflict of validDeletes) {
      try {
        fs.rmSync(this.userFilePath(conflict.kind, conflict.file));
        deleted += 1;
      } catch (error) {
        remaining.push(conflict);
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${conflict.file} 删除失败：${message}`);
      }
    }

    this.writeState({
      version: MIGRATION_CONFLICT_STATE_VERSION,
      status: remaining.length > 0 ? 'pending' : 'resolved',
      conflicts: remaining,
      acceptedIds: [
        ...new Set([
          ...state.acceptedIds,
          ...kept.map(conflict => conflict.id),
        ]),
      ].sort(),
    });
    return {
      success: errors.length === 0,
      kept: kept.length,
      deleted,
      errors,
      remaining: remaining.map(conflict => this.publicConflict(conflict)),
    };
  }

  /** 比较普通计划和日常任务两个受管目录。 */
  private detectConflicts(): StoredMigrationConflict[] {
    const conflicts = [
      ...this.detectDirectoryConflicts(
        'battle',
        this.appPaths.userBattlePlansDir(),
        this.appPaths.systemBattlePlansDir(),
      ),
      ...this.detectDirectoryConflicts(
        'daily',
        this.appPaths.userDailyPlansDir(),
        this.appPaths.systemDailyPlansDir(),
      ),
    ];
    return conflicts.sort((left, right) => (
      left.kind.localeCompare(right.kind)
      || left.file.localeCompare(right.file, 'zh-CN')
    ));
  }

  private detectDirectoryConflicts(
    kind: MigrationConflictKind,
    userDirectory: string,
    systemDirectory: string,
  ): StoredMigrationConflict[] {
    const systemFiles = this.parsedYamlFiles(systemDirectory);
    const systemByName = new Map(systemFiles.map(file => [
      file.file.toLocaleLowerCase(),
      file,
    ]));
    const userFiles = this.parsedYamlFiles(userDirectory);
    const userNames = new Set(userFiles.map(file => (
      file.file.toLocaleLowerCase()
    )));
    const output: StoredMigrationConflict[] = [];

    for (const userFile of userFiles) {
      const reasons: MigrationConflictReason[] = [];
      const exactSystem = systemFiles.find(systemFile => (
        isDeepStrictEqual(userFile.value, systemFile.value)
      ));
      if (exactSystem) {
        reasons.push({
          reasonCode: 'same_as_system_preset',
          reason: `与系统预设「${this.displayName(exactSystem.file)}」内容完全相同`,
          relatedFile: exactSystem.file,
        });
      } else {
        const sameName = systemByName.get(userFile.file.toLocaleLowerCase());
        if (sameName) {
          reasons.push({
            reasonCode: 'same_name_as_system_preset',
            reason: `与系统预设「${this.displayName(sameName.file)}」文件名相同，但配置内容不同`,
            relatedFile: sameName.file,
          });
        }
      }

      const originalFile = this.originalFileForLegacyCopy(userFile.file);
      if (
        originalFile
        && userNames.has(originalFile.toLocaleLowerCase())
      ) {
        reasons.push({
          reasonCode: 'legacy_copy_name_conflict',
          reason: `迁移时因名称冲突保存为旧版副本；现有文件为「${this.displayName(originalFile)}」`,
          relatedFile: originalFile,
        });
      }
      if (reasons.length === 0) continue;

      const content = fs.readFileSync(
        path.join(userDirectory, userFile.file),
        'utf-8',
      );
      const contentHash = this.contentHash(content);
      const id = this.contentHash([
        kind,
        userFile.file,
        contentHash,
        ...reasons.map(reason => reason.reasonCode),
      ].join('\n'));
      output.push({
        id,
        kind,
        file: userFile.file,
        name: this.displayName(userFile.file),
        reasons,
        contentHash,
        systemReplacement: exactSystem?.file,
      });
    }
    return output;
  }

  private parsedYamlFiles(directory: string): ParsedYamlFile[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => (
        entry.isFile()
        && this.isManagedYamlFile(entry.name)
      ))
      .flatMap(entry => {
        try {
          return [{
            file: entry.name,
            value: parseYaml(
              fs.readFileSync(path.join(directory, entry.name), 'utf-8'),
            ),
          }];
        } catch {
          return [];
        }
      });
  }

  private conflictFileStillMatches(
    conflict: StoredMigrationConflict,
  ): boolean {
    if (!this.isManagedYamlFile(conflict.file)) return false;
    const target = this.userFilePath(conflict.kind, conflict.file);
    try {
      if (!fs.existsSync(target)) return false;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      return this.contentHash(fs.readFileSync(target, 'utf-8'))
        === conflict.contentHash;
    } catch {
      return false;
    }
  }

  /** 删除完全相同副本时，把任务组身份切换到对应系统预设。 */
  private rewriteTaskGroupReferences(
    conflicts: StoredMigrationConflict[],
  ): void {
    const replacements = new Map<string, string>();
    for (const conflict of conflicts) {
      if (!conflict.systemReplacement) continue;
      replacements.set(
        `${conflict.kind}:${conflict.file.toLocaleLowerCase()}`,
        conflict.systemReplacement,
      );
    }
    if (replacements.size === 0) return;

    const target = path.join(
      this.appPaths.userDataRoot(),
      'task_groups.json',
    );
    if (!fs.existsSync(target)) return;
    const root = JSON.parse(
      fs.readFileSync(target, 'utf-8'),
    ) as Record<string, unknown>;
    if (!Array.isArray(root.groups)) return;
    let changed = false;
    const groups = root.groups.map(group => {
      if (!this.isPlainObject(group) || !Array.isArray(group.items)) {
        return group;
      }
      return {
        ...group,
        items: group.items.map(item => {
          if (!this.isPlainObject(item)) return item;
          const managedFile = typeof item.managedFile === 'string'
            ? item.managedFile
            : '';
          const battleReplacement = item.managedSource === 'user'
            ? replacements.get(
              `battle:${managedFile.toLocaleLowerCase()}`,
            )
            : undefined;
          if (battleReplacement) {
            changed = true;
            return {
              ...item,
              managedSource: 'system',
              managedFile: battleReplacement,
            };
          }
          const dailyFile = typeof item.dailyFile === 'string'
            ? item.dailyFile
            : '';
          const dailyReplacement = item.dailySource === 'user'
            ? replacements.get(
              `daily:${dailyFile.toLocaleLowerCase()}`,
            )
            : undefined;
          if (!dailyReplacement) return item;
          changed = true;
          return {
            ...item,
            dailySource: 'system',
            dailyFile: dailyReplacement,
          };
        }),
      };
    });
    if (changed) {
      this.atomicFiles.write(
        target,
        JSON.stringify({ ...root, groups }, null, 2),
      );
    }
  }

  /** 删除完全相同副本时，同步切换自动胖次候选和当前选择。 */
  private rewriteAutomationReferences(
    conflicts: StoredMigrationConflict[],
  ): void {
    const replacements = new Map<string, string>();
    for (const conflict of conflicts) {
      if (conflict.kind !== 'battle' || !conflict.systemReplacement) {
        continue;
      }
      replacements.set(
        conflict.file.toLocaleLowerCase(),
        conflict.systemReplacement,
      );
    }
    if (replacements.size === 0) return;

    const target = path.join(
      this.appPaths.userDataRoot(),
      'gui_settings.json',
    );
    if (!fs.existsSync(target)) return;
    const root = JSON.parse(fs.readFileSync(target, 'utf-8')) as unknown;
    if (!this.isPlainObject(root)) return;
    const automation = root.automation;
    if (!this.isPlainObject(automation)) return;

    let changed = false;
    let lootPlans = automation.lootPlans;
    if (Array.isArray(lootPlans)) {
      const seen = new Set<string>();
      lootPlans = lootPlans.map(item => {
        if (
          !this.isPlainObject(item)
          || item.source !== 'user'
          || typeof item.file !== 'string'
        ) {
          return item;
        }
        const replacement = replacements.get(
          item.file.toLocaleLowerCase(),
        );
        if (!replacement) return item;
        changed = true;
        return {
          ...item,
          source: 'system',
          file: replacement,
        };
      }).filter(item => {
        if (
          !this.isPlainObject(item)
          || (item.source !== 'system' && item.source !== 'user')
          || typeof item.file !== 'string'
        ) {
          return true;
        }
        const key = `${item.source}:${item.file.toLocaleLowerCase()}`;
        if (seen.has(key)) {
          changed = true;
          return false;
        }
        seen.add(key);
        return true;
      });
    }

    const selectedFile = typeof automation.lootPlanId === 'string'
      ? automation.lootPlanId
      : '';
    const selectedReplacement = automation.lootPlanSource === 'user'
      ? replacements.get(selectedFile.toLocaleLowerCase())
      : undefined;
    if (selectedReplacement) changed = true;
    if (!changed) return;

    this.atomicFiles.write(
      target,
      JSON.stringify({
        ...root,
        automation: {
          ...automation,
          lootPlans,
          ...(selectedReplacement
            ? {
              lootPlanSource: 'system',
              lootPlanId: selectedReplacement,
            }
            : {}),
        },
      }, null, 2),
    );
  }

  private readState(): MigrationConflictState | null {
    const target = this.statePath();
    if (!fs.existsSync(target)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8')) as unknown;
      if (
        !this.isPlainObject(parsed)
        || parsed.version !== MIGRATION_CONFLICT_STATE_VERSION
        || (parsed.status !== 'pending' && parsed.status !== 'resolved')
        || !Array.isArray(parsed.conflicts)
        || (
          parsed.acceptedIds !== undefined
          && (
            !Array.isArray(parsed.acceptedIds)
            || parsed.acceptedIds.some(id => typeof id !== 'string')
          )
        )
      ) {
        return null;
      }
      const conflicts = parsed.conflicts.filter(
        (value): value is StoredMigrationConflict => (
          this.isStoredConflict(value)
        ),
      );
      return {
        version: MIGRATION_CONFLICT_STATE_VERSION,
        status: parsed.status,
        conflicts,
        acceptedIds: Array.isArray(parsed.acceptedIds)
          ? parsed.acceptedIds as string[]
          : [],
      };
    } catch {
      return null;
    }
  }

  private writeState(state: MigrationConflictState): void {
    fs.mkdirSync(this.appPaths.userDataRoot(), { recursive: true });
    this.atomicFiles.write(
      this.statePath(),
      JSON.stringify(state, null, 2),
    );
  }

  private statePath(): string {
    return path.join(
      this.appPaths.userDataRoot(),
      '.migration-conflicts.json',
    );
  }

  private userFilePath(
    kind: MigrationConflictKind,
    file: string,
  ): string {
    if (!this.isManagedYamlFile(file)) {
      throw new Error('冲突文件名无效');
    }
    const directory = kind === 'battle'
      ? this.appPaths.userBattlePlansDir()
      : this.appPaths.userDailyPlansDir();
    return path.join(directory, file);
  }

  private isStoredConflict(
    value: unknown,
  ): value is StoredMigrationConflict {
    if (!this.isPlainObject(value)) return false;
    return (
      typeof value.id === 'string'
      && (value.kind === 'battle' || value.kind === 'daily')
      && typeof value.file === 'string'
      && this.isManagedYamlFile(value.file)
      && typeof value.name === 'string'
      && Array.isArray(value.reasons)
      && value.reasons.every(reason => (
        this.isPlainObject(reason)
        && typeof reason.reasonCode === 'string'
        && typeof reason.reason === 'string'
      ))
      && typeof value.contentHash === 'string'
      && (
        value.systemReplacement === undefined
        || (
          typeof value.systemReplacement === 'string'
          && this.isManagedYamlFile(value.systemReplacement)
        )
      )
    );
  }

  private publicConflict(
    conflict: StoredMigrationConflict,
  ): MigrationConflictItem {
    return {
      id: conflict.id,
      kind: conflict.kind,
      file: conflict.file,
      name: conflict.name,
      reasons: conflict.reasons.map(reason => ({ ...reason })),
    };
  }

  private originalFileForLegacyCopy(file: string): string | null {
    const extension = path.extname(file);
    const base = file.slice(0, -extension.length);
    const original = base.replace(/（旧版(?: \d+)?）$/, '');
    return original === base ? null : `${original}${extension}`;
  }

  private displayName(file: string): string {
    return file
      .replace(/\.ya?ml$/i, '')
      .replace(/^(?:bettle|exercise|campaign|decisive)-/i, '');
  }

  private isManagedYamlFile(file: string): boolean {
    return (
      file.length > 0
      && file.length <= 255
      && !/[\\/\x00-\x1f]/.test(file)
      && /\.ya?ml$/i.test(file)
    );
  }

  private contentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private isPlainObject(
    value: unknown,
  ): value is Record<string, unknown> {
    return (
      typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
    );
  }
}
