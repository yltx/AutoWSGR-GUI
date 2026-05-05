/**
 * ViewObject 接口定义 —— Controller 传递给 View 的唯一数据结构。
 * View 层只认识这些接口，不依赖任何 Model 或后端类型。
 */

// ════════════════════════════════════════
// 主页面 ViewObject
// ════════════════════════════════════════

/** 当前运行状态 */
export type AppStatus = 'idle' | 'running' | 'stopping' | 'error' | 'not_connected';

/** 主页面 VO */
export interface MainViewObject {
  status: AppStatus;
  statusText: string;
  currentTask: TaskViewObject | null;
  expeditionTimer: string;       // 如 "12:34" 下次远征检查倒计时
  taskQueue: TaskQueueItemVO[];
  wsConnected: boolean;
  /** 当前正在运行的任务 ID（与 taskQueue 中的 id 对应） */
  runningTaskId: string | null;
}

/** 正在执行的任务 */
export interface TaskViewObject {
  name: string;
  type: 'normal_fight' | 'event_fight' | 'campaign' | 'exercise' | 'expedition' | 'decisive';
  progress: string;              // 如 "2/5"
  startedAt: string;
}

/** 队列中排队的任务 */
export interface TaskQueueItemVO {
  id: string;
  name: string;
  priorityLabel: string;         // "远征" | "用户" | "日常"
  remaining: number;
  totalTimes: number;
  /** 进度文本，如 "2/5"，仅当前运行的任务有值 */
  progress?: string;
  /** 进度百分比 0~1，用于进度条 */
  progressPercent?: number;
  /** 实时资源文本（后端出征面板 OCR 结果），如 "装备 3/200 | 舰船 253/500" */
  acquisitionText?: string;
}

/** 日志条目 */
export interface LogEntryVO {
  time: string;       // HH:MM:SS
  level: string;      // debug/info/warning/error
  channel: string;
  message: string;
}

// ════════════════════════════════════════
// Plan 预览页 ViewObject
// ════════════════════════════════════════

/** 地图节点类型 */
export type MapNodeType = 'Start' | 'Normal' | 'Boss' | 'Resource' | 'Penalty' | 'Suppress' | 'Aerial' | 'Hard';

/** 节点信息 */
export interface NodeViewObject {
  id: string;                     // 节点名，如 "A", "B", "M"
  formation: string;              // 阵型中文名
  night: boolean;
  proceed: boolean;
  hasCustomRules: boolean;        // 是否有自定义 enemy_rules
  note: string;                   // 简要备注
  nodeType: MapNodeType;          // 地图数据中的节点类型
  detour: boolean;                // 是否为迂回点
  mapNight: boolean;              // 地图数据中标记为夜战点
  position?: [number, number];    // 地图上的坐标 (已缩放)
}

/** 地图边 (连线) */
export interface MapEdgeVO {
  from: [number, number];
  to: [number, number];
  fromId: string;
  toId: string;
}

/** Plan 预览 VO */
export interface PlanPreviewViewObject {
  fileName: string;
  chapter: number;
  map: number;
  mapName: string;                // "7-4" 格式
  repairModeValue: number;        // 1 或 2
  fightConditionValue: number;    // 1-5
  fleetId: number;                // 1-4
  selectedNodes: NodeViewObject[];
  comment: string;                // yaml 文件顶部注释
  /** 所有地图节点（含未选中的），用于地图可视化 */
  allNodes?: NodeViewObject[];
  /** 地图连线 */
  edges?: MapEdgeVO[];
  /** 编队预设列表 */
  fleetPresets?: FleetPresetVO[];
  /** 任务配置 */
  times?: number;
  gap?: number;
  lootCountGe?: number;
  shipCountGe?: number;
}

/** 编队预设 VO */
export interface FleetPresetVO {
  name: string;
  ships: import('./model.js').ShipSlot[];
}

// ════════════════════════════════════════
// 配置页 ViewObject
// ════════════════════════════════════════

export interface ConfigViewObject {
  emulatorType: string;
  emulatorPath: string;
  emulatorSerial: string;
  gameApp: string;
  updateMode: 'auto' | 'manual';
  autoExpedition: boolean;
  expeditionInterval: number;
  autoBattle: boolean;
  battleType: string;
  autoExercise: boolean;
  exerciseFleetId: number;
  battleTimes: number;
  autoNormalFight: boolean;
  autoDecisive: boolean;
  decisiveTicketReserve: number;
  decisiveTemplateId: string;
  autoLoot: boolean;
  lootPlanIndex: number;
  lootStopCount: number;
  themeMode: 'dark' | 'light' | 'system';
  accentColor: string;
  debugMode: boolean;
  backendPort: number;
  backendStartupMode: 'managed' | 'external';
  backendRepoPath: string;
  ocrGpuMode: 'auto' | 'cpu' | 'cuda';
  saveBackendScreenshots: boolean;
  pythonPath: string;
}

// ════════════════════════════════════════
// 模板库 ViewObject
// ════════════════════════════════════════

export interface TemplateLibraryItemVO {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  planCount: number;
  defaultTimes: number;
  description?: string;
  isBuiltin: boolean;
}

// ════════════════════════════════════════
// 模板向导 ViewObject
// ════════════════════════════════════════

/** 向导 collectForm() 返回的表单数据 */
export interface WizardFormData {
  type: string;
  name: string;
  defaultTimes: number;
  stopLoot: number;
  stopShip: number;
  /** 普通出击 */
  planPath?: string;
  fleetId?: number;
  fleetNf?: string[];
  /** 演习 */
  exerciseFleetId?: number;
  fleetEx?: string[];
  /** 战役 */
  campaignName?: string;
  fleetCp?: string[];
  /** 决战 */
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagshipPriority?: string[];
  useQuickRepair?: boolean;
}

/** 向导预填数据 (editTemplate / importTemplate 时传入) */
export interface WizardPrefillData {
  type?: string;
  name?: string;
  defaultTimes?: number;
  planPaths?: string[];
  planPath?: string;
  fleet_id?: number;
  fleet?: string[];
  campaign_name?: string;
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagship_priority?: string[];
  use_quick_repair?: boolean;
  defaultStopCondition?: { loot_count_ge?: number; ship_count_ge?: number };
}

/** 选择器弹窗选项 */
export interface SelectorOption {
  icon: string;
  label: string;
  sublabel?: string;
}

// ════════════════════════════════════════
// 首次运行引导 ViewObject
// ════════════════════════════════════════

export interface SetupWizardVO {
  emuType: string;
  serial: string;
  pythonPath: string;
}

// ════════════════════════════════════════
// 任务预设 ViewObject
// ════════════════════════════════════════

/** 预设详情面板数据 */
export interface PresetDetailVO {
  name: string;
  typeLabel: string;
  taskType: string;
  fleetId?: number;
  exerciseFleetId?: number;
  campaignName?: string;
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagshipPriority?: string[];
  useQuickRepair?: boolean;
  planId?: string;
  times?: number;
}

/** 预设表单收集值 */
export interface PresetFormValues {
  times: number;
  exerciseFleetId?: number;
  campaignName?: string;
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagshipPriority?: string[];
  useQuickRepair?: boolean;
  planId?: string;
  fightFleetId?: number;
}

/** 新建方案表单值 */
export interface NewPlanFormValues {
  chapter: string;
  map: number;
}
