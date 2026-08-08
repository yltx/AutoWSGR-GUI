/** 持有任务组及条目状态，并负责 JSON 迁移和持久化。 */
/**
 * TaskGroupModel —— 任务组数据模型。
 * 管理多个任务组的增删改查和持久化（通过 IPC 读写 task_groups.json）。
 */
import { Logger } from '../utils/Logger';
import { jsonCodec, rendererFileRepository } from '../adapter/index.js';
import type {
  DailyPlanType,
  PlanPresetSource,
} from '../types/ipc.js';

// ════════════════════════════════════════
// 数据结构
// ════════════════════════════════════════

/** 任务组中的单个条目 */
export interface TaskGroupItem {
  [key: string]: unknown;
  /** 文件路径 (战斗方案/预设 YAML) — plan/preset 类型必填 */
  path?: string;
  /** 计划管理目录来源；与 managedFile 一起使用，避免持久化绝对路径 */
  managedSource?: PlanPresetSource;
  /** 计划管理目录中的实际文件名 */
  managedFile?: string;
  /** 日常任务目录来源；与 dailyFile 一起使用 */
  dailySource?: PlanPresetSource;
  /** 日常任务目录中的实际文件名 */
  dailyFile?: string;
  /** 日常任务类型，用于限制可编辑字段 */
  dailyTaskType?: DailyPlanType;
  /** 模板 ID — template 类型必填 */
  templateId?: string;
  /** 条目类型：daily 使用独立日常任务目录 */
  kind: 'plan' | 'preset' | 'template' | 'daily';
  /** 执行次数 */
  times: number;
  /** 显示名称 */
  label: string;
  /** 战役类型覆盖（仅 campaign 模板使用时选择） */
  campaignName?: string;
  /** 舰队编号覆盖（exercise 模板或 plan 条目可设置） */
  fleet_id?: number;
  /** 是否强制重试（失败后优先重试当前任务） */
  forceRetry?: boolean;
  /** 是否允许同优先级轮询（true=轮询，false/未设置=连续执行） */
  allowPolling?: boolean;
  /** 章节覆盖（仅 decisive 模板使用时选择） */
  chapter?: number;
  /** 决战快速修理开关覆盖 */
  useQuickRepair?: boolean;
  /** 编队预设索引（plan 类型条目指定默认使用的编队预设） */
  fleetPresetIndex?: number;
}

/** 一个任务组 */
export interface TaskGroup {
  [key: string]: unknown;
  /** 唯一名称 */
  name: string;
  /** 有序的任务条目 */
  items: TaskGroupItem[];
}

/** 持久化格式 */
interface TaskGroupsData {
  [key: string]: unknown;
  version: number;
  /** 当前选中的组名 */
  activeGroup: string;
  /** 所有组 */
  groups: TaskGroup[];
}

// ════════════════════════════════════════
// Model
// ════════════════════════════════════════

const STORAGE_FILE = 'task_groups.json';
const TASK_GROUPS_VERSION = 4;
const LEGACY_SYSTEM_PLAN_FILES: Readonly<Record<string, string>> = {
  '周常2章-2-1.yaml': 'bettle-周常-2-1.yaml',
  '周常3章-3-1.yaml': 'bettle-周常-3-1.yaml',
  '周常4章-4-1.yaml': 'bettle-周常-4-1.yaml',
  '周常5章-5-5.yaml': 'bettle-周常-5-5.yaml',
  '周常6章-6-4.yaml': 'bettle-周常-6-4.yaml',
  '周常7章-7-4.yaml': 'bettle-周常-7-4.yaml',
  '周常8章-8-2.yaml': 'bettle-周常-8-2.yaml',
  '周常9章-9-2.yaml': 'bettle-周常-9-2.yaml',
  '周常10章-10-1.yaml': 'bettle-周常-10-1.yaml',
};

export class TaskGroupModel {
  private data: TaskGroupsData = { version: TASK_GROUPS_VERSION, activeGroup: '', groups: [] };

  get groups(): ReadonlyArray<TaskGroup> {
    return this.data.groups;
  }

  get activeGroupName(): string {
    return this.data.activeGroup;
  }

  /** 获取当前选中的组，若不存在返回 null */
  getActiveGroup(): TaskGroup | null {
    return this.data.groups.find(g => g.name === this.data.activeGroup) ?? null;
  }

  /** 切换选中组 */
  setActiveGroup(name: string): void {
    this.data.activeGroup = name;
  }

  /** 获取指定名称的组 */
  getGroup(name: string): TaskGroup | null {
    return this.data.groups.find(g => g.name === name) ?? null;
  }

  /** 创建或更新 (同名覆盖) 一个组，返回该组 */
  upsertGroup(name: string, items?: TaskGroupItem[]): TaskGroup {
    const existing = this.data.groups.find(g => g.name === name);
    if (existing) {
      if (items) existing.items = items;
      return existing;
    }
    const group: TaskGroup = { name, items: items ?? [] };
    this.data.groups.push(group);
    if (!this.data.activeGroup) this.data.activeGroup = name;
    return group;
  }

  /** 重命名组 */
  renameGroup(oldName: string, newName: string): boolean {
    if (oldName === newName) return true;
    if (this.data.groups.some(g => g.name === newName)) return false;
    const group = this.data.groups.find(g => g.name === oldName);
    if (!group) return false;
    group.name = newName;
    if (this.data.activeGroup === oldName) this.data.activeGroup = newName;
    return true;
  }

  /** 删除组 */
  deleteGroup(name: string): boolean {
    const idx = this.data.groups.findIndex(g => g.name === name);
    if (idx === -1) return false;
    this.data.groups.splice(idx, 1);
    if (this.data.activeGroup === name) {
      this.data.activeGroup = this.data.groups[0]?.name ?? '';
    }
    return true;
  }

  /** 向指定组追加条目 */
  addItem(groupName: string, item: TaskGroupItem): boolean {
    const group = this.data.groups.find(g => g.name === groupName);
    if (!group) return false;
    group.items.push(item);
    return true;
  }

  /** 移除指定组的指定位置条目 */
  removeItem(groupName: string, index: number): boolean {
    const group = this.data.groups.find(g => g.name === groupName);
    if (!group || index < 0 || index >= group.items.length) return false;
    group.items.splice(index, 1);
    return true;
  }

  /** 移动条目 (拖拽排序) */
  moveItem(groupName: string, fromIndex: number, toIndex: number): boolean {
    const group = this.data.groups.find(g => g.name === groupName);
    if (!group) return false;
    if (fromIndex < 0 || fromIndex >= group.items.length) return false;
    if (toIndex < 0 || toIndex >= group.items.length) return false;
    const [item] = group.items.splice(fromIndex, 1);
    group.items.splice(toIndex, 0, item);
    return true;
  }

  /** 更新条目的次数 */
  updateItemTimes(groupName: string, index: number, times: number): boolean {
    const group = this.data.groups.find(g => g.name === groupName);
    if (!group || index < 0 || index >= group.items.length) return false;
    group.items[index].times = Math.max(1, times);
    return true;
  }

  // ── 持久化 ──

  /** 从文件加载 */
  async load(): Promise<void> {
    try {
      const content = await rendererFileRepository.readFile(STORAGE_FILE);
      const parsed = jsonCodec.parse<Partial<TaskGroupsData> & { groups?: unknown }>(content);
      if (parsed && Array.isArray(parsed.groups)) {
        const needsMigration = parsed.version !== TASK_GROUPS_VERSION;
        this.data = this.migrate({ ...parsed, groups: parsed.groups });
        if (needsMigration) await this.save();
        Logger.debug(`任务组已加载: ${this.data.groups.length} 个组 (v${this.data.version})`);
      }
    } catch {
      // 文件不存在是正常的
    }
  }

  private migrate(raw: Partial<TaskGroupsData> & { groups: unknown[] }): TaskGroupsData {
    const groups = raw.groups.flatMap((group): TaskGroup[] => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) return [];
      const source = group as unknown as Record<string, unknown>;
      const name = typeof source.name === 'string' && source.name.trim()
        ? source.name
        : '默认';
      const items = Array.isArray(source.items)
        ? source.items.flatMap(item => this.migrateItem(item))
        : [];
      return [{ ...source, name, items } as TaskGroup];
    });
    const activeGroup = typeof raw.activeGroup === 'string'
      && groups.some(group => group.name === raw.activeGroup)
      ? raw.activeGroup
      : groups[0]?.name ?? '';
    return {
      ...raw,
      version: TASK_GROUPS_VERSION,
      activeGroup,
      groups,
    };
  }

  private migrateItem(raw: unknown): TaskGroupItem[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const source = { ...(raw as Record<string, unknown>) };
    const kind = (
      source.kind === 'preset'
      || source.kind === 'template'
      || source.kind === 'daily'
    )
      ? source.kind
      : 'plan';
    const pathValue = typeof source.path === 'string' && source.path.trim()
      ? source.path
      : undefined;
    const managedFile = typeof source.managedFile === 'string' && source.managedFile.trim()
      ? source.managedFile
      : undefined;
    const managedSource = source.managedSource === 'system' || source.managedSource === 'user'
      ? source.managedSource
      : this.inferManagedSource(pathValue);
    const dailySource = source.dailySource === 'system' || source.dailySource === 'user'
      ? source.dailySource
      : undefined;
    const dailyFile = typeof source.dailyFile === 'string' && source.dailyFile.trim()
      ? source.dailyFile
      : undefined;
    const inferredFile = managedFile ?? this.inferManagedFile(pathValue);
    const migratedFile = managedSource === 'system' && inferredFile
      ? LEGACY_SYSTEM_PLAN_FILES[inferredFile] ?? inferredFile
      : inferredFile;
    const label = typeof source.label === 'string' && source.label.trim()
      ? source.label
      : (migratedFile ?? pathValue ?? '任务').split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? '任务';
    return [{
      ...source,
      kind,
      path: pathValue,
      managedSource,
      managedFile: migratedFile,
      dailySource,
      dailyFile,
      times: typeof source.times === 'number' && source.times > 0 ? source.times : 1,
      label,
    } as TaskGroupItem];
  }

  private inferManagedSource(value: string | undefined): PlanPresetSource | undefined {
    if (!value) return undefined;
    if (/system_battle_plans|builtin_plans|system[\\/]/i.test(value)) return 'system';
    if (/user_battle_plans|plans[\\/]|user[\\/]/i.test(value)) return 'user';
    return undefined;
  }

  private inferManagedFile(value: string | undefined): string | undefined {
    if (!value || !/\.ya?ml$/i.test(value)) return undefined;
    const source = this.inferManagedSource(value);
    if (!source) return undefined;
    const file = value.split(/[\\/]/).pop();
    return file && file.trim() ? file : undefined;
  }

  /** 保存到文件 */
  async save(): Promise<boolean> {
    try {
      await rendererFileRepository.saveFile(STORAGE_FILE, jsonCodec.stringify(this.data));
      Logger.debug(`任务组已保存: ${this.data.groups.length} 个组`);
      return true;
    } catch (e) {
      Logger.error(`保存任务组失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
