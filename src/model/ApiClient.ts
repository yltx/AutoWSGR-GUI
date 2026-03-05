/**
 * ApiClient —— 与 AutoWSGR 后端 HTTP Server 通信的服务层。
 * 封装所有 REST 调用和 WebSocket 连接管理。
 */

const DEFAULT_BASE_URL = 'http://localhost:8000';
const WS_RECONNECT_DELAY = 3000;

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

export interface RoundResult {
  round: number;
  success: boolean;
  nodes?: string[];
  mvp?: string | null;
  ship_damage?: number[];
  grade?: string | null;
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

// ════════════════════════════════════════
// 请求体类型
// ════════════════════════════════════════

export interface NodeDecisionReq {
  formation?: number;
  night?: boolean;
  proceed?: boolean;
  proceed_stop?: number[];
  detour?: boolean;
  enemy_rules?: string[][] | null;
}

export interface CombatPlanReq {
  name?: string;
  mode?: string;
  chapter?: number | string;
  map?: number | string;
  fleet_id?: number;
  fleet?: string[] | null;
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

// ════════════════════════════════════════
// ApiClient 实现
// ════════════════════════════════════════

export class ApiClient {
  private baseUrl: string;
  private wsLog: WebSocket | null = null;
  private wsTask: WebSocket | null = null;
  private callbacks: ApiClientCallbacks = {};
  private reconnectTimers: { log?: ReturnType<typeof setTimeout>; task?: ReturnType<typeof setTimeout> } = {};

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  setCallbacks(cb: ApiClientCallbacks): void {
    this.callbacks = cb;
  }

  // ── HTTP 方法 ──

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    };
    if (timeoutMs) {
      const ac = new AbortController();
      init.signal = ac.signal;
      setTimeout(() => ac.abort(), timeoutMs);
    }
    const resp = await fetch(url, init);
    return resp.json() as Promise<ApiResponse<T>>;
  }

  // ── 系统管理 ──

  async systemStart(configPath?: string, timeoutMs?: number): Promise<ApiResponse> {
    return this.request('POST', '/api/system/start', {
      config_path: configPath ?? null,
    }, timeoutMs);
  }

  async systemStop(): Promise<ApiResponse> {
    return this.request('POST', '/api/system/stop');
  }

  async systemStatus(): Promise<ApiResponse<SystemStatus>> {
    return this.request('GET', '/api/system/status');
  }

  // ── 任务执行 ──

  async taskStart(req: TaskRequest): Promise<ApiResponse<TaskStartResult>> {
    return this.request('POST', '/api/task/start', req);
  }

  async taskStop(): Promise<ApiResponse> {
    return this.request('POST', '/api/task/stop');
  }

  async taskStatus(): Promise<ApiResponse<TaskStatus>> {
    return this.request('GET', '/api/task/status');
  }

  // ── 远征收取 ──
  // 后端目前没有单独的远征 API endpoint，由调度器内部穿插。
  // 前端远征按钮预留，调度器通过 taskStart 配合后端的 expedition_interval 实现。

  // ── WebSocket ──

  connectWebSockets(): void {
    this.connectLogWs();
    this.connectTaskWs();
  }

  disconnectWebSockets(): void {
    clearTimeout(this.reconnectTimers.log);
    clearTimeout(this.reconnectTimers.task);
    this.wsLog?.close();
    this.wsTask?.close();
    this.wsLog = null;
    this.wsTask = null;
  }

  private wsBaseUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws');
  }

  private connectLogWs(): void {
    if (this.wsLog?.readyState === WebSocket.OPEN) return;
    try {
      this.wsLog = new WebSocket(`${this.wsBaseUrl()}/ws/logs`);

      this.wsLog.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage;
          if (msg.type === 'log' && this.callbacks.onLog) {
            this.callbacks.onLog(msg as WsLogMessage);
          }
        } catch { /* ignore malformed */ }
      };

      this.wsLog.onopen = () => {
        this.callbacks.onWsStatusChange?.(true);
      };

      this.wsLog.onclose = () => {
        this.callbacks.onWsStatusChange?.(false);
        this.reconnectTimers.log = setTimeout(() => this.connectLogWs(), WS_RECONNECT_DELAY);
      };

      this.wsLog.onerror = () => {
        this.wsLog?.close();
      };
    } catch {
      this.reconnectTimers.log = setTimeout(() => this.connectLogWs(), WS_RECONNECT_DELAY);
    }
  }

  private connectTaskWs(): void {
    if (this.wsTask?.readyState === WebSocket.OPEN) return;
    try {
      this.wsTask = new WebSocket(`${this.wsBaseUrl()}/ws/task`);

      this.wsTask.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage;
          if (msg.type === 'task_update' && this.callbacks.onTaskUpdate) {
            this.callbacks.onTaskUpdate(msg as WsTaskUpdate);
          } else if (msg.type === 'task_completed' && this.callbacks.onTaskCompleted) {
            this.callbacks.onTaskCompleted(msg as WsTaskCompleted);
          }
        } catch { /* ignore malformed */ }
      };

      this.wsTask.onclose = () => {
        this.reconnectTimers.task = setTimeout(() => this.connectTaskWs(), WS_RECONNECT_DELAY);
      };

      this.wsTask.onerror = () => {
        this.wsTask?.close();
      };
    } catch {
      this.reconnectTimers.task = setTimeout(() => this.connectTaskWs(), WS_RECONNECT_DELAY);
    }
  }
}
