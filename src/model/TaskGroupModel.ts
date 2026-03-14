/**
 * TaskGroupModel —— 任务组数据模型。
 * 管理多个任务组的增删改查和持久化（通过 IPC 读写 task_groups.json）。
 */
import { Logger } from '../utils/Logger';

// ════════════════════════════════════════
// 数据结构
// ════════════════════════════════════════

/** 任务组中的单个条目 */
export interface TaskGroupItem {
  /** 文件路径 (战斗方案/预设 YAML) — plan/preset 类型必填 */
  path?: string;
  /** 模板 ID — template 类型必填 */
  templateId?: string;
  /** 条目类型: plan=战斗方案YAML, preset=任务预设YAML, template=模板库引用 */
  kind: 'plan' | 'preset' | 'template';
  /** 执行次数 */
  times: number;
  /** 显示名称 */
  label: string;
  /** 战役类型覆盖（仅 campaign 模板使用时选择） */
  campaignName?: string;
  /** 舰队编号覆盖（仅 exercise 模板使用时选择） */
  fleet_id?: number;
  /** 章节覆盖（仅 decisive 模板使用时选择） */
  chapter?: number;
}

/** 一个任务组 */
export interface TaskGroup {
  /** 唯一名称 */
  name: string;
  /** 有序的任务条目 */
  items: TaskGroupItem[];
}

/** 持久化格式 */
interface TaskGroupsData {
  /** 当前选中的组名 */
  activeGroup: string;
  /** 所有组 */
  groups: TaskGroup[];
}

// ════════════════════════════════════════
// Model
// ════════════════════════════════════════

const STORAGE_FILE = 'task_groups.json';

export class TaskGroupModel {
  private data: TaskGroupsData = { activeGroup: '', groups: [] };

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
      const bridge = (window as any).electronBridge;
      if (!bridge?.readFile) return;
      const content = await bridge.readFile(STORAGE_FILE);
      const parsed = JSON.parse(content) as TaskGroupsData;
      if (parsed && Array.isArray(parsed.groups)) {
        this.data = parsed;
        Logger.debug(`任务组已加载: ${parsed.groups.length} 个组`);
      }
    } catch {
      // 文件不存在是正常的
    }
  }

  /** 保存到文件 */
  async save(): Promise<void> {
    try {
      const bridge = (window as any).electronBridge;
      if (!bridge?.saveFile) return;
      await bridge.saveFile(STORAGE_FILE, JSON.stringify(this.data, null, 2));
      Logger.debug(`任务组已保存: ${this.data.groups.length} 个组`);
    } catch (e) {
      Logger.error(`保存任务组失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 序列化 (用于调试) */
  toJSON(): TaskGroupsData {
    return structuredClone(this.data);
  }
}
