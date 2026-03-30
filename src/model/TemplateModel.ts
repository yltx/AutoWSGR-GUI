import type { TaskTemplate } from '../types/model';

const FILE_PATH = 'templates/templates.json';
const BUILTIN_PATH = 'resource/builtin_templates.json';

let idCounter = 0;
function generateId(): string {
  return `tpl_${Date.now()}_${++idCounter}`;
}

/** 通过 IPC 桥读写文件的接口 */
interface FileIO {
  readFile: (path: string) => Promise<string>;
  saveFile: (path: string, content: string) => Promise<void>;
}

export class TemplateModel {
  private builtinTemplates: TaskTemplate[] = [];
  private userTemplates: TaskTemplate[] = [];
  private io: FileIO | null = null;

  /** 初始化：传入 IPC bridge 并从本地文件加载 */
  async init(io: FileIO): Promise<void> {
    this.io = io;
    await this.loadBuiltin();
    await this.load();
  }

  /** 所有模板（内置 + 用户） */
  getAll(): readonly TaskTemplate[] {
    return [...this.builtinTemplates, ...this.userTemplates];
  }

  /** 查找模板 */
  get(id: string): TaskTemplate | undefined {
    return this.builtinTemplates.find(t => t.id === id)
      ?? this.userTemplates.find(t => t.id === id);
  }

  /** 是否为内置模板 */
  isBuiltin(id: string): boolean {
    return this.builtinTemplates.some(t => t.id === id);
  }

  /** 添加模板 */
  async add(tpl: Omit<TaskTemplate, 'id' | 'createdAt'>): Promise<TaskTemplate> {
    const full: TaskTemplate = {
      ...tpl,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    this.userTemplates.push(full);
    await this.save();
    return full;
  }

  /** 删除模板（内置模板不可删除） */
  async remove(id: string): Promise<boolean> {
    if (this.isBuiltin(id)) return false;
    const idx = this.userTemplates.findIndex(t => t.id === id);
    if (idx < 0) return false;
    this.userTemplates.splice(idx, 1);
    await this.save();
    return true;
  }

  /** 重命名模板（内置模板不可重命名） */
  async rename(id: string, newName: string): Promise<void> {
    if (this.isBuiltin(id)) return;
    const tpl = this.userTemplates.find(t => t.id === id);
    if (tpl) {
      tpl.name = newName;
      await this.save();
    }
  }

  /** 更新模板字段（内置模板不可更新） */
  async update(id: string, fields: Partial<Omit<TaskTemplate, 'id' | 'createdAt' | 'builtin'>>): Promise<void> {
    if (this.isBuiltin(id)) return;
    const tpl = this.userTemplates.find(t => t.id === id);
    if (tpl) {
      Object.assign(tpl, fields);
      await this.save();
    }
  }

  /** 从 JSON 数组导入模板，自动分配新 id */
  async importFromJson(raw: unknown[]): Promise<number> {
    let count = 0;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (!rec.name || !rec.type) continue;
      const tpl: TaskTemplate = {
        ...(rec as any),
        id: generateId(),
        createdAt: new Date().toISOString(),
      };
      // 导入的模板始终为用户模板
      delete (tpl as any).builtin;
      this.userTemplates.push(tpl);
      count++;
    }
    if (count > 0) await this.save();
    return count;
  }

  /** 持久化用户模板到本地文件 */
  private async save(): Promise<void> {
    if (!this.io) return;
    await this.io.saveFile(FILE_PATH, JSON.stringify(this.userTemplates, null, 2));
  }

  /** 从本地文件加载用户模板 */
  private async load(): Promise<void> {
    if (!this.io) return;
    try {
      const raw = await this.io.readFile(FILE_PATH);
      if (raw) {
        this.userTemplates = JSON.parse(raw);
        return;
      }
    } catch { /* 文件不存在 */ }
    // 迁移：尝试从旧路径 templates.json 加载
    try {
      const raw = await this.io.readFile('templates.json');
      if (raw) {
        this.userTemplates = JSON.parse(raw);
        await this.save(); // 保存到新路径
      }
    } catch { /* 旧文件也不存在，使用空列表 */ }
  }

  /** 从只读资源加载内置模板 */
  private async loadBuiltin(): Promise<void> {
    if (!this.io) return;
    try {
      const raw = await this.io.readFile(BUILTIN_PATH);
      if (raw) {
        const arr = JSON.parse(raw) as TaskTemplate[];
        // 确保内置标记
        this.builtinTemplates = arr.map(t => ({ ...t, builtin: true }));
      }
    } catch { /* 内置模板文件不存在 */ }
  }
}
