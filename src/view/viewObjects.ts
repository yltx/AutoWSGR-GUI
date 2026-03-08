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
  /** 进度文本，如 "2/5"，仅当前运行的任务有值 */
  progress?: string;
  /** 进度百分比 0~1，用于进度条 */
  progressPercent?: number;
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
}

// ════════════════════════════════════════
// 配置页 ViewObject
// ════════════════════════════════════════

export interface ConfigViewObject {
  emulatorType: string;
  emulatorPath: string;
  emulatorSerial: string;
  gameApp: string;
  autoExpedition: boolean;
  expeditionInterval: number;
  autoBattle: boolean;
  battleType: string;
  autoExercise: boolean;
  exerciseFleetId: number;
  battleTimes: number;
  themeMode: 'dark' | 'light' | 'system';
  accentColor: string;
  debugMode: boolean;
}
