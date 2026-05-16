/**
 * Scheduler 公共类型定义。
 * 从 Scheduler.ts 提取，供 Controller / View 层直接引用。
 */
import type { TaskRequest, TaskResult, WsLogMessage } from './api';
import type { StopCondition, BathRepairConfig, FleetPreset } from './model';

// ════════════════════════════════════════
// 任务队列项
// ════════════════════════════════════════

/** 任务优先级: 数值越小优先级越高 */
export enum TaskPriority {
  EXPEDITION = 0,   // 远征检查 (最高)
  USER_TASK = 10,   // 用户手动发起的任务
  DAILY = 20,       // 日常自动任务 (战役/演习)
}

export type SchedulerTaskType =
  | 'normal_fight'
  | 'event_fight'
  | 'campaign'
  | 'exercise'
  | 'decisive'
  | 'expedition';

export interface SchedulerTask {
  id: string;
  name: string;
  type: SchedulerTaskType;
  priority: TaskPriority;
  request: TaskRequest;
  /** 重复剩余次数 (用于任务分拆: 打500次 → 每次打1次然后后触发剩余) */
  remainingTimes: number;
  /** 总次数（用于显示进度） */
  totalTimes: number;
  /** 后端返回的 task_id (仅当前正在运行的任务有值) */
  backendTaskId?: string;
  /** 可选的停止条件: 每轮完成后检查，满足则不再后触发 */
  stopCondition?: StopCondition;
  /** 失败后最大重试次数 (默认 2) */
  maxRetries: number;
  /** 当前已重试次数 */
  retryCount: number;
  /** 是否强制重试（重试时插入同优先级队首） */
  forceRetry?: boolean;
  /** 是否允许同优先级轮询（true=轮询，false/未设置=连续执行） */
  allowPolling?: boolean;
  /** 泡澡修理配置 (可选) */
  bathRepairConfig?: BathRepairConfig;
  /** 任务使用的编队号 (用于泡澡修理前检查编队状态) */
  fleetId?: number;
  /** 可用的编队预设列表 (用于泡澡修理时轮换舰船) */
  fleetPresets?: FleetPreset[];
  /** 当前使用的编队预设索引 (-1 = 未使用预设) */
  currentPresetIndex?: number;
  /** 终点节点列表：经过其中任一节点即认定本轮完成。未设置时回退到最后一个 selected_node。 */
  endpointNodes?: string[];
  /** 同优先级内排序键（数值越小越靠前），用于周常等需要严格按章节顺序执行的场景 */
  sortKey?: number;
}

// ════════════════════════════════════════
// 调度器状态
// ════════════════════════════════════════

export type SchedulerStatus = 'idle' | 'running' | 'stopping' | 'not_connected';

// ════════════════════════════════════════
// 事件回调
// ════════════════════════════════════════

export interface SchedulerCallbacks {
  /** 调度器状态改变 (idle/running/stopping) */
  onStatusChange?: (status: SchedulerStatus) => void;
  /** 当前任务进度更新 */
  onProgressUpdate?: (taskId: string, progress: { current: number; total: number; node: string | null }) => void;
  /** 任务完成 (单轮) */
  onTaskCompleted?: (taskId: string, success: boolean, result?: TaskResult | null, error?: string | null) => void;
  /** 新日志消息 */
  onLog?: (msg: WsLogMessage) => void;
  /** 队列变化 */
  onQueueChange?: (queue: ReadonlyArray<SchedulerTask>) => void;
  /** WebSocket 连接状态 */
  onConnectionChange?: (connected: boolean) => void;
  /** 远征倒计时更新 (秒) */
  onExpeditionTimerTick?: (remainingSeconds: number) => void;
}
