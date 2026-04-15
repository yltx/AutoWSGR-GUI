/**
 * API / WebSocket 通信类型定义。
 * 从 ApiClient.ts 提取，供各层直接引用。
 */

// ════════════════════════════════════════
// 后端 API 响应类型
// ════════════════════════════════════════

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface TaskStartResult {
  task_id: string;
  status: string;
}

export interface TaskProgress {
  current: number;
  total: number;
  node: string | null;
}

export interface CombatEvent {
  type: string;
  node: string | null;
  action: string | null;
  result?: unknown;
  enemies?: Record<string, number>;
  ship_stats?: number[];
}

export interface RoundResult {
  round: number;
  success: boolean;
  nodes?: string[];
  mvp?: string | null;
  ship_damage?: number[];
  grade?: string | null;
  node_count?: number;
  enemies?: Record<string, Record<string, number>>;
  events?: CombatEvent[];
  error?: string;
}

export interface TaskResult {
  total_runs: number;
  success_runs: number;
  details: RoundResult[];
}

export interface TaskStatus {
  task_id: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped';
  progress: TaskProgress | null;
  result: TaskResult | null;
  error?: string | null;
}

export interface SystemStatus {
  status: string;
  emulator_connected: boolean;
  game_running: boolean;
  current_task: string | null;
}

export interface ShipData {
  name: string;
  ship_type: string | null;
  level: number;
  health: number;
  max_health: number;
  damage_state: number;
  locked: boolean;
}

export interface FleetData {
  fleet_id: number;
  ships: ShipData[];
  size: number;
  has_severely_damaged: boolean;
}

export interface ExpeditionSlot {
  chapter: number | null;
  node: number | null;
  fleet_id: number | null;
  is_active: boolean;
  remaining_seconds: number;
}

export interface ExpeditionQueueData {
  slots: ExpeditionSlot[];
  active_count: number;
  idle_count: number;
}

export interface BuildSlotData {
  occupied: boolean;
  remaining_seconds: number;
  is_complete: boolean;
  is_idle: boolean;
}

export interface BuildQueueData {
  slots: BuildSlotData[];
  idle_count: number;
  complete_count: number;
}

export interface ResourcesData {
  fuel: number;
  ammo: number;
  steel: number;
  aluminum: number;
  diamond: number;
  fast_repair: number;
  fast_build: number;
  ship_blueprint: number;
  equipment_blueprint: number;
}

export interface GameContextData {
  dropped_ship_count: number;
  dropped_loot_count: number;
  quick_repair_used: number;
  current_page: string | null;
  resources?: ResourcesData;
  fleets?: FleetData[];
  expeditions?: ExpeditionQueueData;
  build_queue?: BuildQueueData;
}

export interface GameAcquisitionData {
  ship_count: number | null;
  ship_max: number | null;
  loot_count: number | null;
  loot_max: number | null;
}

// ════════════════════════════════════════
// 请求体类型
// ════════════════════════════════════════

export interface NodeDecisionReq {
  formation?: number;
  night?: boolean;
  long_missile_support?: boolean;
  proceed?: boolean;
  proceed_stop?: number[];
  detour?: boolean;
  enemy_rules?: string[][] | null;
}

export interface FleetRuleReq {
  /** 候选舰船名（按优先级顺序） */
  candidates: string[];
  /** 搜索关键词（用于同名舰船精确筛选） */
  search_name?: string;
  /** 舰种约束（如 cl/cav/ss），用于同名舰船二次筛选 */
  ship_type?: string;
  /** 等级下限（仅选择 >= 该等级） */
  min_level?: number;
  /** 等级上限（仅选择 <= 该等级） */
  max_level?: number;
}

export interface CombatPlanReq {
  name?: string;
  mode?: string;
  chapter?: number | string;
  map?: number | string;
  fleet_id?: number;
  fleet?: string[] | null;
  fleet_rules?: Array<string | FleetRuleReq> | null;
  repair_mode?: number[];
  fight_condition?: number;
  selected_nodes?: string[];
  node_defaults?: NodeDecisionReq;
  node_args?: Record<string, NodeDecisionReq>;
  event_name?: string | null;
}

export interface NormalFightReq {
  type: 'normal_fight';
  plan?: CombatPlanReq | null;
  plan_id?: string | null;
  times?: number;
  gap?: number;
}

export interface EventFightReq {
  type: 'event_fight';
  plan?: CombatPlanReq | null;
  plan_id?: string | null;
  times?: number;
  gap?: number;
  fleet_id?: number | null;
}

export interface CampaignReq {
  type: 'campaign';
  campaign_name: string;
  times?: number;
}

export interface ExerciseReq {
  type: 'exercise';
  fleet_id?: number;
}

export interface DecisiveReq {
  type: 'decisive';
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagship_priority?: string[];
  use_quick_repair?: boolean;
}

export type TaskRequest =
  | NormalFightReq
  | EventFightReq
  | CampaignReq
  | ExerciseReq
  | DecisiveReq;

// ════════════════════════════════════════
// WebSocket 消息类型
// ════════════════════════════════════════

export interface WsLogMessage {
  type: 'log';
  timestamp: string;
  level: string;
  channel: string;
  message: string;
}

export interface WsTaskUpdate {
  type: 'task_update';
  task_id: string;
  status: string;
  progress?: TaskProgress;
}

export interface WsTaskCompleted {
  type: 'task_completed';
  task_id: string;
  success: boolean;
  result?: TaskResult | null;
  error?: string | null;
}

export type WsMessage = WsLogMessage | WsTaskUpdate | WsTaskCompleted;

// ════════════════════════════════════════
// 事件回调类型
// ════════════════════════════════════════

export interface ApiClientCallbacks {
  onLog?: (msg: WsLogMessage) => void;
  onTaskUpdate?: (msg: WsTaskUpdate) => void;
  onTaskCompleted?: (msg: WsTaskCompleted) => void;
  onWsStatusChange?: (connected: boolean) => void;
}
