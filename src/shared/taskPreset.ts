/** 识别、校验并归一化独立任务预设。 */
import type {
  StopCondition,
  TaskPreset,
} from '../types/model.js';

export type TaskPresetType = TaskPreset['task_type'];
export type TaskPresetDocument =
  TaskPreset & Record<string, unknown>;

const TASK_PRESET_TYPES = [
  'normal_fight',
  'event_fight',
  'campaign',
  'exercise',
  'decisive',
] as const satisfies readonly TaskPresetType[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

function isTaskPresetType(value: string): value is TaskPresetType {
  return TASK_PRESET_TYPES.some(type => type === value);
}

/** 负责独立任务预设的类型判断和字段校验。 */
export class TaskPresetCodec {
  /** 含 task_type 但不含完整地图坐标的 YAML 是独立任务预设。 */
  isStandalone(root: Record<string, unknown>): boolean {
    return (
      typeof root.task_type === 'string'
      && (!('chapter' in root) || !('map' in root))
    );
  }

  /** 校验已识别的独立任务预设，并保留未知业务字段。 */
  normalize(root: Record<string, unknown>): TaskPresetDocument {
    const rawType = typeof root.task_type === 'string'
      ? root.task_type.trim().toLowerCase()
      : '';
    if (!isTaskPresetType(rawType)) {
      throw new Error(`不支持的任务预设类型：${rawType || '空'}`);
    }
    const result: TaskPresetDocument = {
      ...structuredClone(root),
      task_type: rawType,
    };

    this.normalizeCommonFields(result);
    if (rawType === 'normal_fight' || rawType === 'event_fight') {
      result.plan_id = this.safePlanReference(root.plan_id);
      if (root.fleet_id !== undefined) {
        result.fleet_id = this.positiveInteger(
          root.fleet_id,
          'fleet_id',
        );
      }
    } else if (rawType === 'campaign') {
      result.campaign_name = this.nonEmptyText(
        root.campaign_name,
        'campaign_name',
      );
    } else if (rawType === 'exercise') {
      result.fleet_id = this.integerInRange(
        root.fleet_id,
        'fleet_id',
        1,
        4,
      );
    } else {
      result.chapter = this.positiveInteger(root.chapter, 'chapter');
      result.level1 = this.shipNames(root.level1, 'level1');
      result.level2 = this.shipNames(root.level2, 'level2');
      if (root.flagship_priority !== undefined) {
        result.flagship_priority = this.shipNames(
          root.flagship_priority,
          'flagship_priority',
        );
      }
      if (
        root.use_quick_repair !== undefined
        && typeof root.use_quick_repair !== 'boolean'
      ) {
        throw new Error('use_quick_repair 必须是布尔值');
      }
    }
    return result;
  }

  private normalizeCommonFields(result: TaskPresetDocument): void {
    if (result.times !== undefined) {
      result.times = this.positiveInteger(result.times, 'times');
    }
    if (result.gap !== undefined) {
      if (
        typeof result.gap !== 'number'
        || !Number.isFinite(result.gap)
        || result.gap < 0
      ) {
        throw new Error('gap 必须是大于或等于 0 的数字');
      }
    }
    if (result.stop_condition !== undefined) {
      result.stop_condition = this.stopCondition(
        result.stop_condition,
      );
    }
    if (
      result.scheduled_time !== undefined
      && (
        typeof result.scheduled_time !== 'string'
        || !result.scheduled_time.trim()
      )
    ) {
      throw new Error('scheduled_time 必须是非空字符串');
    }
  }

  /** 独立任务预设不能保留任意绝对路径或目录跳转。 */
  private safePlanReference(value: unknown): string {
    const reference = this.nonEmptyText(value, 'plan_id');
    if (
      /^[A-Za-z]:[/\\]/.test(reference)
      || reference.startsWith('/')
      || reference.startsWith('\\\\')
      || reference.split(/[\\/]/).includes('..')
    ) {
      throw new Error('plan_id 不能引用受管目录外的路径');
    }
    return reference;
  }

  private nonEmptyText(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${field} 必须是非空字符串`);
    }
    return value.trim();
  }

  private positiveInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value) || Number(value) < 1) {
      throw new Error(`${field} 必须是大于或等于 1 的整数`);
    }
    return Number(value);
  }

  private integerInRange(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
  ): number {
    const result = this.positiveInteger(value, field);
    if (result < minimum || result > maximum) {
      throw new Error(`${field} 必须是 ${minimum} 到 ${maximum}`);
    }
    return result;
  }

  private shipNames(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
      throw new Error(`${field} 必须是舰名列表`);
    }
    return value.map((item, index) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`${field}[${index}] 必须是非空舰名`);
      }
      return item.trim();
    });
  }

  private stopCondition(value: unknown): StopCondition {
    if (!isRecord(value)) {
      throw new Error('stop_condition 必须是对象');
    }
    const result: StopCondition = {};
    for (const field of ['loot_count_ge', 'ship_count_ge'] as const) {
      const count = value[field];
      if (count === undefined) continue;
      if (!Number.isInteger(count) || Number(count) < 0) {
        throw new Error(
          `stop_condition.${field} 必须是大于或等于 0 的整数`,
        );
      }
      result[field] = Number(count);
    }
    return result;
  }
}

export const taskPresetCodec = new TaskPresetCodec();
