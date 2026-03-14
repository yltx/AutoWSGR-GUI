/**
 * Model 层类型定义 —— 与后端 AutoWSGR 数据结构对应。
 * 这些是"高内聚"的业务实体，包含内部状态操作。
 */

// ════════════════════════════════════════
// 战斗方案 (Plan)
// ════════════════════════════════════════

/** 索敌规则条目: [条件表达式, 动作] */
export type EnemyRule = [string, string | number];

/** 单个节点的战斗参数 */
export interface NodeArgs {
  enemy_rules?: EnemyRule[];
  formation?: number;              // 1-5
  night?: boolean;
  proceed?: boolean;
  proceed_stop?: number[];         // 6 个元素
  SL_when_detour_fails?: boolean;
}

/** 编队预设: 一组预定义的舰船配置 */
export interface FleetPreset {
  /** 显示名称 */
  name: string;
  /** 舰船名列表 (按位置顺序) */
  ships: string[];
}

/** Plan 文件解析后的完整数据 */
export interface PlanData {
  chapter: number;
  map: number;
  selected_nodes: string[];
  fight_condition?: number;        // 1-5, 默认 1
  repair_mode?: number | number[];  // 1 或 2（或每舰位数组）, 默认 1
  fleet_id?: number;               // 编队号
  node_defaults?: NodeArgs;
  node_args?: Record<string, NodeArgs>;
  /** 预定义编队预设列表 */
  fleet_presets?: FleetPreset[];
  // 任务级字段（可内联在 plan 中，无需单独的 preset 文件）
  times?: number;
  gap?: number;
  stop_condition?: StopCondition;
  /** 定时触发时间 "HH:MM" 格式，到时自动加入队列 */
  scheduled_time?: string;
}

// ════════════════════════════════════════
// 用户配置
// ════════════════════════════════════════

export interface EmulatorConfig {
  type: string;
  path?: string;
  serial?: string;
}

export interface AccountConfig {
  game_app: string;
  account?: string;
  password?: string;
}

export interface DailyAutomation {
  auto_expedition: boolean;
  expedition_interval: number; // 远征检查间隔（分钟）
  auto_battle: boolean;
  battle_type: string;
  battle_times: number;
  auto_exercise: boolean;
  exercise_fleet_id: number;
  auto_normal_fight: boolean;
  auto_decisive: boolean;
  decisive_ticket_reserve: number;
  decisive_template_id: string;
}

export interface UserSettings {
  emulator: EmulatorConfig;
  account: AccountConfig;
  daily_automation: DailyAutomation;
}

// ════════════════════════════════════════
// 常量映射
// ════════════════════════════════════════

export const FORMATION_NAMES: Record<number, string> = {
  1: '单纵阵',
  2: '复纵阵',
  3: '轮型阵',
  4: '梯形阵',
  5: '单横阵',
};

export const FIGHT_CONDITION_NAMES: Record<number, string> = {
  1: '稳步前进',
  2: '火力万岁',
  3: '小心翼翼',
  4: '瞄准',
  5: '搜索阵型',
};

export const REPAIR_MODE_NAMES: Record<number, string> = {
  1: '中破就修',
  2: '大破才修',
};

// ════════════════════════════════════════
// 停止条件 (Stop Condition)
// ════════════════════════════════════════

/** 停止条件: 满足时自动终止任务循环 */
export interface StopCondition {
  /** 战利品数量达到上限时停止 */
  loot_count_ge?: number;
  /** 舰船获取数量达到上限时停止 */
  ship_count_ge?: number;
}

// ════════════════════════════════════════
// 任务预设 (Task Preset)
// ════════════════════════════════════════

/** 任务预设 YAML 解析后的结构 (task_type 字段用于区分) */
export interface TaskPreset {
  task_type: 'normal_fight' | 'event_fight' | 'campaign' | 'exercise' | 'decisive';
  // normal_fight / event_fight
  plan_id?: string;
  times?: number;
  gap?: number;
  fleet_id?: number;
  // campaign
  campaign_name?: string;
  // decisive
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagship_priority?: string[];
  // 停止条件
  stop_condition?: StopCondition;
  /** 定时触发时间 "HH:MM" 格式 */
  scheduled_time?: string;
}

// ════════════════════════════════════════
// 任务模板 (Task Template)
// ════════════════════════════════════════

/** 模板类型 */
export type TemplateType = 'normal_fight' | 'exercise' | 'campaign' | 'decisive';

/** 任务模板：可复用的任务蓝图 */
export interface TaskTemplate {
  id: string;
  name: string;
  type: TemplateType;
  createdAt: string;

  /** 是否为内置模板（只读，不可删除/编辑） */
  builtin?: boolean;
  /** 内置模板的描述说明 */
  description?: string;

  // normal_fight / event_fight
  planPath?: string;               // 引用的方案文件路径（单方案，向后兼容）
  planPaths?: string[];            // 可选方案列表（多方案模板）
  fleet_id?: number;
  fleet?: string[];                // 编队舰船名称 (6 个位置)

  // exercise
  // fleet_id 已定义

  // campaign
  campaign_name?: string;

  // decisive
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagship_priority?: string[];

  // 默认运行时参数
  defaultTimes?: number;
  defaultGap?: number;
  defaultStopCondition?: StopCondition;
}

// ════════════════════════════════════════
// 泡澡修理配置 (Bath Repair)
// ════════════════════════════════════════

/** 单船修理阈值: 血量低于阈值时送入泡澡 */
export interface RepairThreshold {
  /** 阈值类型: percent=百分比 (如0.25=25%), absolute=绝对值 (如13点HP) */
  type: 'percent' | 'absolute';
  /** 阈值数值 */
  value: number;
}

/** 任务级泡澡修理配置 */
export interface BathRepairConfig {
  /** 是否启用泡澡修理（启用后不使用快修，等待泡澡完成） */
  enabled: boolean;
  /** 默认修理阈值（适用于所有舰船） */
  defaultThreshold: RepairThreshold;
  /** 按舰船名覆盖修理阈值 (显示名 → 阈值) */
  shipThresholds?: Record<string, RepairThreshold>;
}
