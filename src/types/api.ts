/** 定义 Renderer 与后端 HTTP/WebSocket 通信使用的请求、响应和事件类型。 */

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
  /** 任务业务结果，例如 chapter_clear、leave、error、out of times。 */
  result?: string;
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

export interface IntensifyRequest {
  target_ship: string;
  material_ship_types: string[] | null;
  max_materials: number;
  protected_ships: string[];
}

export interface IntensifyPreviewData extends IntensifyRequest {
  executable: false;
  reason: string;
}

export interface IntensifyStatsData {
  firepower: number;
  torpedo: number;
  armor: number;
  antiAir: number;
}

export interface IntensifyTargetOccurrenceData {
  ref: string;
  shipId: number;
  identity: string;
  occurrence: number;
  current: IntensifyStatsData;
}

export interface IntensifyMaterialOccurrenceData {
  ref: string;
  shipId: number;
  identity: string;
  index: number;
}

export interface IntensifySnapshotSessionData {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  targetTotal: number;
  targetRevision: string;
  materialTotal: number;
  materialViewportCount: number;
  targets: IntensifyTargetOccurrenceData[];
  materials: IntensifyMaterialOccurrenceData[];
}

export interface IntensifySnapshotPreviewRequest {
  session_id: string;
  selected_target_ref: string;
  allowed_material_identities: string[];
  maximum_materials: number;
  selected_material_refs: string[];
}

export interface IntensifyTargetCandidateData extends IntensifyTargetOccurrenceData {
  maximum: IntensifyStatsData;
  deficit: IntensifyStatsData;
  projectedGains: IntensifyStatsData;
  projected: IntensifyStatsData;
  needsIntensify: boolean;
}

export interface IntensifyMaterialCandidateData {
  ref: string;
  identity: string;
  index: number;
  contribution: IntensifyStatsData;
  rarity: number;
  requiresConfirmation: boolean;
  eligible: boolean;
  reason: string;
}

export interface IntensifySnapshotPreviewData {
  targetRevision: string;
  materialRevision: string;
  executionPath: 'direct' | 'confirmation_required' | null;
  executable: false;
  targets: IntensifyTargetCandidateData[];
  materials: IntensifyMaterialCandidateData[];
}

export interface NodeDecisionReq {
  formation?: number;
  night?: boolean;
  long_missile_support?: boolean;
  proceed?: boolean;
  proceed_stop?: number[];
  detour?: boolean;
  SL_when_detour_fails?: boolean;
  enemy_rules?: Array<[string, RuleAction]> | null;
  enemy_formation_rules?: Array<[string, RuleAction]> | null;
  SL_when_spot_enemy_fails?: boolean;
  SL_when_enter_fight?: boolean;
  formation_when_spot_enemy_fails?: number | null;
}

export type RuleAction = 'retreat' | 'detour' | 1 | 2 | 3 | 4 | 5;

export interface FleetShipRuleReq {
  name: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  relaxed?: boolean;
}

export interface FleetRuleReq extends Omit<FleetShipRuleReq, 'name'> {
  name?: string;
  candidates?: FleetShipRuleReq[];
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
  decisive_rounds?: number;
  use_new_fleet_change_algorithm?: boolean;
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

export interface ApiClientCallbacks {
  onLog?: (msg: WsLogMessage) => void;
  onTaskUpdate?: (msg: WsTaskUpdate) => void;
  onTaskCompleted?: (msg: WsTaskCompleted) => void;
  onWsStatusChange?: (connected: boolean) => void;
}
