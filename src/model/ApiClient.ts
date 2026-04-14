/**
 * ApiClient —— 与 AutoWSGR 后端 HTTP Server 通信的服务层。
 * 封装所有 REST 调用和 WebSocket 连接管理。
 */

const DEFAULT_BASE_URL = 'http://localhost:8438';
const WS_RECONNECT_DELAY = 3000;

import { Logger } from '../utils/Logger';
import type {
  ApiResponse,
  ApiClientCallbacks,
  TaskStartResult,
  TaskStatus,
  SystemStatus,
  TaskRequest,
  GameContextData,
  GameAcquisitionData,
  WsMessage,
  WsLogMessage,
  WsTaskUpdate,
  WsTaskCompleted,
} from '../types/api';

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
    Logger.debug(`HTTP ${method} ${path}${body ? ' body=' + JSON.stringify(body) : ''}`, 'api');
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

  async emulatorDevices(): Promise<ApiResponse<{ serial: string; status: string }[]>> {
    return this.request('GET', '/api/system/emulator/devices', undefined, 15000);
  }

  // ── 任务执行 ──

  private static formatValidationDetail(detail: unknown): string {
    if (!Array.isArray(detail)) return '任务启动失败';
    const parts = detail
      .map((item) => {
        const row = item as { loc?: unknown; msg?: unknown };
        const loc = Array.isArray(row.loc) ? row.loc.map(String).join('.') : 'request';
        const msg = typeof row.msg === 'string' ? row.msg : '参数校验失败';
        return `${loc}: ${msg}`;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('; ') : '任务启动失败';
  }

  private static shouldRetryTaskStartWithLegacyPayload(payload: unknown): boolean {
    const p = payload as { detail?: unknown };
    if (!Array.isArray(p?.detail)) return false;
    return p.detail.some((item) => {
      const row = item as { type?: unknown; loc?: unknown };
      if (row.type !== 'extra_forbidden') return false;
      const loc = Array.isArray(row.loc) ? row.loc.map(String).join('.') : '';
      return loc.includes('fleet_rules') || loc.includes('long_missile_support');
    });
  }

  private static makeLegacyTaskRequest(req: TaskRequest): TaskRequest {
    const cloned = JSON.parse(JSON.stringify(req)) as TaskRequest & {
      plan?: {
        fleet_rules?: unknown;
        node_defaults?: { long_missile_support?: unknown };
        node_args?: Record<string, { long_missile_support?: unknown }>;
      };
    };

    const plan = cloned.plan;
    if (!plan) return cloned;

    delete plan.fleet_rules;
    if (plan.node_defaults) {
      delete plan.node_defaults.long_missile_support;
    }
    if (plan.node_args) {
      for (const nodeArg of Object.values(plan.node_args)) {
        if (!nodeArg) continue;
        delete nodeArg.long_missile_support;
      }
    }

    return cloned;
  }

  private static normalizeTaskStartResponse(payload: unknown): ApiResponse<TaskStartResult> {
    const p = payload as ApiResponse<TaskStartResult> & { detail?: unknown };
    if (typeof p?.success === 'boolean') return p;
    return {
      success: false,
      error: ApiClient.formatValidationDetail(p?.detail),
    };
  }

  async taskStart(req: TaskRequest): Promise<ApiResponse<TaskStartResult>> {
    const first = await this.request('POST', '/api/task/start', req);
    const firstNormalized = ApiClient.normalizeTaskStartResponse(first);
    if (firstNormalized.success) return firstNormalized;

    if (!ApiClient.shouldRetryTaskStartWithLegacyPayload(first)) {
      return firstNormalized;
    }

    const legacyReq = ApiClient.makeLegacyTaskRequest(req);
    Logger.warn('检测到后端 schema 不支持新字段，本次请求回退为兼容负载重试一次', 'api');
    const retried = await this.request('POST', '/api/task/start', legacyReq);
    return ApiClient.normalizeTaskStartResponse(retried);
  }

  async taskStop(): Promise<ApiResponse> {
    return this.request('POST', '/api/task/stop');
  }

  async taskStatus(): Promise<ApiResponse<TaskStatus>> {
    return this.request('GET', '/api/task/status');
  }

  // ── 远征收取 ──

  async expeditionCheck(): Promise<ApiResponse> {
    return this.request('POST', '/api/expedition/check');
  }

  async expeditionAutoCheck(allowRepair = true): Promise<ApiResponse> {
    return this.request('POST', '/api/expedition/auto_check', { allow_repair: allowRepair });
  }

  // ── 游戏状态查询 ──

  async gameContext(): Promise<ApiResponse<GameContextData>> {
    return this.request('GET', '/api/game/context');
  }

  async gameAcquisition(): Promise<ApiResponse<GameAcquisitionData>> {
    return this.request('GET', '/api/game/acquisition');
  }

  // ── 操作端点 ──

  async buildCollect(): Promise<ApiResponse> {
    return this.request('POST', '/api/build/collect');
  }

  async buildStart(fuel = 30, ammo = 30, steel = 30, bauxite = 30): Promise<ApiResponse> {
    return this.request('POST', '/api/build/start', { fuel, ammo, steel, bauxite });
  }

  async rewardCollect(): Promise<ApiResponse> {
    return this.request('POST', '/api/reward/collect');
  }

  async cook(position = 1): Promise<ApiResponse> {
    return this.request('POST', '/api/cook', { position });
  }

  async repairBath(): Promise<ApiResponse> {
    return this.request('POST', '/api/repair/bath');
  }

  /** 单船泡澡修理（后端接受舰船名称，自动导航到浴室并修理） */
  async repairShip(shipName: string): Promise<ApiResponse> {
    return this.request('POST', '/api/repair/ship', { ship_name: shipName });
  }

  async destroy(shipTypes?: string[], removeEquipment = true): Promise<ApiResponse> {
    return this.request('POST', '/api/destroy', { ship_types: shipTypes ?? null, remove_equipment: removeEquipment });
  }

  // ── 健康检查 ──

  async health(): Promise<ApiResponse<{ status: string; uptime_seconds: number; emulator_connected: boolean; current_task: unknown }>> {
    return this.request('GET', '/api/health');
  }

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
        } catch {
          Logger.debug('WS /logs: malformed message', 'api');
        }
      };

      this.wsLog.onopen = () => {
        Logger.debug('WS /logs connected', 'api');
        this.callbacks.onWsStatusChange?.(true);
      };

      this.wsLog.onclose = () => {
        Logger.debug('WS /logs disconnected, reconnect in 3s', 'api');
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
        } catch {
          Logger.debug('WS /task: malformed message', 'api');
        }
      };

      this.wsTask.onclose = () => {
        Logger.debug('WS /task disconnected, reconnect in 3s', 'api');
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
