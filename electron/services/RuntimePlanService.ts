/**
 * 生成供后端执行的已展开临时计划。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFileStore } from './AtomicFileStore';
import { CombatPlanCodec } from './CombatPlanCodec';
import { CombatPlanRepository } from './CombatPlanRepository';
import { type PlanPresetSource } from './TeamPlanCodec';

export interface PreparedCombatPlan {
  sourcePath: string;
  runtimePath: string;
  content: string;
}

export interface RuntimePlanDependencies {
  getTempDirectory(): string;
  processId: number;
  now?(): number;
}

/** 负责生成后端执行使用的已展开临时计划。 */
export class RuntimePlanService {
  private sequence = 0;

  constructor(
    private readonly codec: CombatPlanCodec,
    private readonly repository: CombatPlanRepository,
    private readonly atomicFiles: AtomicFileStore,
    private readonly dependencies: RuntimePlanDependencies,
  ) {}

  /** 返回当前进程专用的运行时计划目录。 */
  directory(): string {
    return path.join(
      this.dependencies.getTempDirectory(),
      'AutoWSGR-GUI',
      'runtime_battle_plans',
      String(this.dependencies.processId),
    );
  }

  /** 校验并写入一份已经展开的运行时计划。 */
  write(content: string, hint: string): string {
    const parsed = this.codec.parseRoot(
      content,
      '运行时出征计划必须包含 chapter 和 map',
    );
    if (!('chapter' in parsed) || !('map' in parsed)) {
      throw new Error('运行时出征计划必须包含 chapter 和 map');
    }
    if (
      Array.isArray(parsed.fleet_presets)
      && parsed.fleet_presets.some(preset => (
        !this.codec.isPlainObject(preset)
        || !Array.isArray(preset.ships)
      ))
    ) {
      throw new Error('运行时出征计划包含尚未展开的舰队引用');
    }

    const directory = this.directory();
    fs.mkdirSync(directory, { recursive: true });
    this.sequence++;
    const safeHint = this.codec.safeBaseName(hint) || 'plan';
    const timestamp = this.dependencies.now?.() ?? Date.now();
    const file = `${safeHint}-${timestamp}-${this.sequence}.yaml`;
    const target = path.join(directory, file);
    this.atomicFiles.write(target, content);
    return target;
  }

  /** 读取受管计划、展开舰队引用并生成运行时文件。 */
  prepare(
    source: PlanPresetSource,
    file: string,
  ): PreparedCombatPlan {
    const sourcePath = this.repository.safeManagedPath(source, file);
    if (!sourcePath || !this.repository.exists(sourcePath)) {
      throw new Error('出征计划不存在');
    }
    const originalContent = this.repository.read(sourcePath);
    const parsed = this.codec.parseRoot(
      originalContent,
      '无效的出征计划',
    );
    const expanded = this.codec.expandRoot(parsed, source);
    const content = this.codec.serialize(expanded, originalContent);
    return {
      sourcePath,
      runtimePath: this.write(content, file),
      content,
    };
  }
}
