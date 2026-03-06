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

/** Plan 文件解析后的完整数据 */
export interface PlanData {
  chapter: number;
  map: number;
  selected_nodes: string[];
  fight_condition?: number;        // 1-5, 默认 1
  repair_mode?: number;            // 1 或 2, 默认 1
  node_defaults?: NodeArgs;
  node_args?: Record<string, NodeArgs>;
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
  auto_battle: boolean;
  battle_type: string;
  auto_exercise: boolean;
  exercise_fleet_id?: number;
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
  2: '大破就修',
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
}
