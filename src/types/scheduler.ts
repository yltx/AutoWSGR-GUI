/** 定义任务队列、调度状态及 Scheduler 对外回调契约。 */
import type { TaskRequest, TaskResult, WsLogMessage } from './api.js';
import type {
  StopCondition,
  BathRepairConfig,
  FleetPreset,
  BattleResultGrade,
} from './model.js';

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

export interface ExpeditionCheckRequest {
  type: 'expedition';
}

export type SchedulerTaskRequest =
  | TaskRequest
  | ExpeditionCheckRequest;

export interface SchedulerTask {
  id: string;
  /** Stable identity for all single-round follow-up tasks. */
  logicalId: string;
  name: string;
  type: SchedulerTaskType;
  priority: TaskPriority;
  request: SchedulerTaskRequest;
  /** 重复剩余次数 (用于任务分拆: 打500次 → 每次打1次然后后触发剩余) */
  remainingTimes: number;
  /** 总次数（用于显示进度） */
  totalTimes: number;
  /** 后端 times=None：任务不受次数限制，完成一轮后继续排队。 */
  unlimited?: boolean;
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
  /** 终点节点的最低战果要求；未设置时仅判断是否经过终点。 */
  endpointResult?: BattleResultGrade;
  /**
   * 同优先级内排序键（数值越小越靠前）。
   * 业务任务入队时不传该参数（默认 undefined=Infinity，被 push 到队尾，等价于按加入时间排序）；
   * 仅用于内部重试/跟随等需要插入到特定位置的场景。
   */
  sortKey?: number;
}

// ════════════════════════════════════════
// 调度器状态
// ════════════════════════════════════════

export type SchedulerStatus = 'idle' | 'running' | 'stopping' | 'not_connected';

/** 逻辑任务被取消的来源，用于区分用户放弃和系统关闭。 */
export type LogicalTaskCancelReason =
  | 'removed'
  | 'queue_cleared'
  | 'system_stopped';

/** 逻辑任务结束原因，供自动任务区分自然结束和停止条件达成。 */
export type LogicalTaskCompletionReason =
  | 'completed'
  | 'failed'
  | 'terminal'
  | 'stop_condition';

/** 尚未回到就绪队列的任务，例如轮次间隔或失败重试。 */
export interface SchedulerWaitingTask {
  task: SchedulerTask;
  reason: 'gap' | 'retry';
  readyAt: number;
}

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
  /**
   * Emitted only when the logical task has no follow-up round.
   * countedRound 仅在 Scheduler 确认本轮满足终点/战果要求时为 true。
   */
  onLogicalTaskCompleted?: (
    logicalId: string,
    success: boolean,
    error?: string | null,
    countedRound?: boolean,
    reason?: LogicalTaskCompletionReason,
  ) => void;
  /** 逻辑任务被删除、清空或随系统停止，不等同于完成或失败。 */
  onLogicalTaskCanceled?: (
    logicalId: string,
    reason: LogicalTaskCancelReason,
  ) => void;
  /** 新日志消息 */
  onLog?: (msg: WsLogMessage) => void;
  /** 队列变化 */
  onQueueChange?: (queue: ReadonlyArray<SchedulerTask>) => void;
  /** WebSocket 连接状态 */
  onConnectionChange?: (connected: boolean) => void;
  /** 远征倒计时更新 (秒) */
  onExpeditionTimerTick?: (remainingSeconds: number) => void;
}
