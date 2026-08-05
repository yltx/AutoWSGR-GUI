/** 定义配置、作战方案、舰队规则、模板和修理等领域数据结构。 */

import type {
  LootAutomationPlan,
  LootPlanSource,
} from '../shared/lootPlans.js';
import type {
  DecisiveAutomationSource,
} from '../shared/decisiveAutomation.js';

export interface EmulatorConfig {
  type: string;
  path?: string;
  serial?: string;
  process_name?: string;
}

export interface AccountConfig {
  game_app: string;
}

export interface NormalFightTaskConfig {
  name: string;
  fleet_id?: number;
  fleet_preset_index?: number;
  times?: number;
}

export interface DailyAutomationConfig {
  auto_expedition: boolean;
  auto_gain_bonus: boolean;
  auto_bath_repair: boolean;
  auto_set_support: boolean;
  bath_repair_blacklist: string[];
  auto_battle: boolean;
  battle_type: string;
  auto_exercise: boolean;
  exercise_fleet_id: number | null;
  auto_normal_fight: boolean;
  normal_fight_tasks: NormalFightTaskConfig[];
  quick_repair_limit: number | null;
  stop_max_ship: boolean;
  stop_max_loot: boolean;
}

export interface OCRConfig {
  gpu: boolean;
  mirror: 'origin' | 'github' | 'tencent' | 'modelscope';
  enhanced_ship_ocr: boolean;
  ship_name_match_confidence: number;
  ship_name_corrections: Record<string, string>;
  ship_name_aliases: Record<string, string>;
}

export interface LogConfig {
  level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  root: string;
  dir?: string | null;
  show_decisive_battle_info?: boolean;
  show_emulator_debug?: boolean;
  show_ui_debug?: boolean;
  show_vision_debug?: boolean;
  show_ops_debug?: boolean;
  show_combat_state_debug?: boolean;
  show_combat_recognition_debug?: boolean;
  channels?: Record<string, string>;
}

export interface GuiAutomationSettings {
  expeditionInterval: number;
  battleTimes: number;
  autoDecisive: boolean;
  /** 自动决战使用计划页方案或系统预设。 */
  decisiveTemplateId: DecisiveAutomationSource;
  autoLoot: boolean;
  /** 当前自动胖次计划来源。 */
  lootPlanSource: LootPlanSource;
  /** 当前自动胖次计划文件名，不受界面选项顺序影响。 */
  lootPlanId: string;
  /** 设置页自动胖次下拉列表。 */
  lootPlans: LootAutomationPlan[];
  lootStopCount: number;
}

export interface UserSettings {
  emulator: EmulatorConfig;
  account: AccountConfig;
  ocr: OCRConfig;
  log: LogConfig;
  daily_automation: DailyAutomationConfig;
  operation_delay_min: number;
  operation_delay_max: number;
  dock_full_destroy: boolean;
  repair_manually: boolean;
  bathroom_count: number;
  destroy_ship_work_mode: number;
  destroy_ship_types: string[];
  remove_equipment_mode: boolean;
  plan_root?: string;
}

export type RuleAction = 'retreat' | 'detour' | 1 | 2 | 3 | 4 | 5;
export type EnemyRule = [string, RuleAction];

export type BattleResultGrade = 'D' | 'C' | 'B' | 'A' | 'S' | 'SS';

export interface NodeArgs {
  enemy_rules?: EnemyRule[];
  formation?: number;
  night?: boolean;
  long_missile_support?: boolean;
  proceed?: boolean;
  detour?: boolean;
  proceed_stop?: number[];
  SL_when_detour_fails?: boolean;
  enemy_formation_rules?: EnemyRule[];
  SL_when_spot_enemy_fails?: boolean;
  SL_when_enter_fight?: boolean;
  formation_when_spot_enemy_fails?: number | null;
}

export interface ShipRule {
  name: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  relaxed?: boolean;
}

export interface ShipFilter {
  name?: string;
  search_name?: string;
  nation?: string;
  ship_type?: string[];
  candidates?: ShipRule[];
  min_level?: number;
  max_level?: number;
  relaxed?: boolean;
}

export type ShipSlot = string | ShipFilter | null;

export interface FleetPreset {
  name: string;
  ships: ShipSlot[];
}

export type EventChapter = 'E' | 'H';

export interface EventMapCatalogEntry {
  event: string;
  chapters: Record<EventChapter, string[]>;
  files?: Record<EventChapter, Record<string, string>>;
}

export interface EventMapCatalog {
  schema_version: number;
  events: EventMapCatalogEntry[];
}

export interface PlanData {
  chapter: number | string;
  map: number | string;
  mode?: string;
  event?: string;
  selected_nodes: string[];
  endpoint_nodes?: string[];
  result?: BattleResultGrade;
  fight_condition?: number;
  repair_mode?: number | number[];
  fleet_id?: number;
  node_defaults?: NodeArgs;
  node_args?: Record<string, NodeArgs>;
  fleet_presets?: FleetPreset[];
  times?: number;
  gap?: number;
  stop_condition?: StopCondition;
  scheduled_time?: string;
}

export interface StopCondition {
  loot_count_ge?: number;
  ship_count_ge?: number;
}

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

export interface TaskPreset {
  task_type:
    | 'normal_fight'
    | 'event_fight'
    | 'campaign'
    | 'exercise'
    | 'decisive';
  plan_id?: string;
  times?: number;
  gap?: number;
  fleet_id?: number;
  campaign_name?: string;
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagship_priority?: string[];
  use_quick_repair?: boolean;
  stop_condition?: StopCondition;
  scheduled_time?: string;
}

export type TemplateType =
  | 'normal_fight'
  | 'event_fight'
  | 'exercise'
  | 'campaign'
  | 'decisive';

export interface TaskTemplate {
  id: string;
  name: string;
  type: TemplateType;
  createdAt: string;
  builtin?: boolean;
  description?: string;
  forceRetry?: boolean;
  allowPolling?: boolean;
  planPath?: string;
  planPaths?: string[];
  fleet_id?: number;
  fleet?: string[];
  campaign_name?: string;
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagship_priority?: string[];
  use_quick_repair?: boolean;
  defaultTimes?: number;
  defaultGap?: number;
  defaultStopCondition?: StopCondition;
}

export interface RepairThreshold {
  type: 'percent' | 'absolute';
  value: number;
}

export interface BathRepairConfig {
  enabled: boolean;
  defaultThreshold: RepairThreshold;
  shipThresholds?: Record<string, RepairThreshold>;
}
