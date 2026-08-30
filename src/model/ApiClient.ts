/** 提供后端业务 API、任务控制和 WebSocket 事件客户端。 */
/**
 * ApiClient —— 与 AutoWSGR 后端 HTTP Server 通信的服务层。
 * 封装所有 REST 调用和 WebSocket 连接管理。
 */

const DEFAULT_BASE_URL = 'http://localhost:8438';
const WS_RECONNECT_DELAY = 3000;

import { Logger } from '../utils/Logger';
import {
  createHttpTransport,
  type HttpTransport,
  webSocketTransport,
  type WebSocketTransport,
  jsonCodec,
} from '../adapter/index.js';
import type {
  ApiResponse,
  ApiClientCallbacks,
  TaskStartResult,
  TaskStatus,
  SystemStatus,
  TaskRequest,
  GameContextData,
  GameAcquisitionData,
  IntensifyRequest,
  IntensifyPreviewData,
  IntensifySnapshotPreviewData,
  IntensifySnapshotPreviewRequest,
  IntensifySnapshotSessionData,
  WsMessage,
  WsLogMessage,
  WsTaskUpdate,
  WsTaskCompleted,
} from '../types/api.js';

// ════════════════════════════════════════
// ApiClient 实现
// ════════════════════════════════════════

export class ApiClient {
  private baseUrl: string;
  private wsLog: WebSocket | null = null;
  private wsTask: WebSocket | null = null;
  private shouldReconnectWebSockets = false;
  private callbacks: ApiClientCallbacks = {};
  private reconnectTimers: { log?: ReturnType<typeof setTimeout>; task?: ReturnType<typeof setTimeout> } = {};
  private readonly http: HttpTransport;
  private readonly ws: WebSocketTransport;

  constructor(
    baseUrl: string = DEFAULT_BASE_URL,
    http: HttpTransport = createHttpTransport(baseUrl),
    ws: WebSocketTransport = webSocketTransport,
  ) {
    this.baseUrl = baseUrl;
    this.http = http;
    this.ws = ws;
  }

  setCallbacks(cb: ApiClientCallbacks): void {
    this.callbacks = cb;
  }

  // ── HTTP 方法 ──

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<ApiResponse<T>> {
    Logger.debug(`HTTP ${method} ${path}${body ? ' body=' + jsonCodec.stringify(body) : ''}`, 'api');
    return this.http.request<ApiResponse<T>>(method, path, body, timeoutMs);
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

  /** 当前没有生产调用方引用，保留给模拟器设备选择功能。 */
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
    const cloned = jsonCodec.parse<TaskRequest & {
      plan?: {
        fleet_rules?: unknown;
        node_defaults?: { long_missile_support?: unknown };
        node_args?: Record<string, { long_missile_support?: unknown }>;
      };
    }>(jsonCodec.stringify(req));

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

  /** 当前没有生产调用方引用，保留给建造启动功能。 */
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
  async repairShip(
    shipName: string,
  ): Promise<ApiResponse<{ repair_seconds?: number }>> {
    return this.request('POST', '/api/repair/ship', { ship_name: shipName });
  }

  /** 当前没有生产调用方引用，保留给批量解体功能。 */
  async destroy(shipTypes?: string[], removeEquipment = true): Promise<ApiResponse> {
    return this.request('POST', '/api/destroy', { ship_types: shipTypes ?? null, remove_equipment: removeEquipment });
  }

  /** 执行自动强化（自动扫描、规划并执行强化） */
  async autoIntensify(policy?: IntensifyRequest): Promise<ApiResponse> {
    return this.request('POST', '/api/intensify', policy);
  }

  /** 纯策略预览：后端不读取设备上下文，也不会点击或消耗舰船。 */
  async intensifyPreview(policy: IntensifyRequest): Promise<ApiResponse<IntensifyPreviewData>> {
    return this.request('POST', '/api/intensify/preview', policy);
  }

  /** 扫描完整目标与素材库存并创建短期只读 Session；请求没有 body。 */
  async createIntensifySnapshotSession(): Promise<ApiResponse<IntensifySnapshotSessionData>> {
    return this.request('POST', '/api/intensify/snapshot-sessions');
  }

  /** 使用服务端 Session 和 exact occurrence refs 生成不可执行候选预览。 */
  async intensifySnapshotPreview(
    request: IntensifySnapshotPreviewRequest,
  ): Promise<{
    status?: number;
    response: ApiResponse<IntensifySnapshotPreviewData>;
  }> {
    Logger.debug(
      `HTTP POST /api/intensify/snapshot-preview body=${jsonCodec.stringify(request)}`,
      'api',
    );
    if (!this.http.requestWithStatus) {
      return {
        response: await this.http.request<ApiResponse<IntensifySnapshotPreviewData>>(
          'POST',
          '/api/intensify/snapshot-preview',
          request,
        ),
      };
    }
    const result = await this.http.requestWithStatus<ApiResponse<IntensifySnapshotPreviewData>>(
      'POST',
      '/api/intensify/snapshot-preview',
      request,
    );
    return { status: result.status, response: result.data };
  }

  // ── 健康检查 ──

  async health(): Promise<ApiResponse<{ status: string; uptime_seconds: number; emulator_connected: boolean; current_task: unknown }>> {
    return this.request('GET', '/api/health');
  }

  // ── WebSocket ──

  connectWebSockets(): void {
    this.shouldReconnectWebSockets = true;
    this.connectLogWs();
    this.connectTaskWs();
  }

  disconnectWebSockets(): void {
    this.shouldReconnectWebSockets = false;
    clearTimeout(this.reconnectTimers.log);
    clearTimeout(this.reconnectTimers.task);
    this.reconnectTimers = {};
    this.wsLog?.close();
    this.wsTask?.close();
    this.wsLog = null;
    this.wsTask = null;
  }

  private wsBaseUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws');
  }

  private connectLogWs(): void {
    if (!this.shouldReconnectWebSockets) return;
    if (this.wsLog && (
      this.wsLog.readyState === WebSocket.OPEN
      || this.wsLog.readyState === WebSocket.CONNECTING
    )) return;
    try {
      this.wsLog = this.ws.connect(`${this.wsBaseUrl()}/ws/logs`, {
        onMessage: data => {
          try {
            const msg = jsonCodec.parse<WsMessage>(data);
            if (msg.type === 'log' && this.callbacks.onLog) this.callbacks.onLog(msg as WsLogMessage);
          } catch {
            Logger.debug('WS /logs: malformed message', 'api');
          }
        },
        onOpen: () => {
          Logger.debug('WS /logs connected', 'api');
          this.callbacks.onWsStatusChange?.(true);
        },
        onClose: () => {
          this.callbacks.onWsStatusChange?.(false);
          if (!this.shouldReconnectWebSockets) return;
          Logger.debug('WS /logs disconnected, reconnect in 3s', 'api');
          this.reconnectTimers.log = setTimeout(() => this.connectLogWs(), WS_RECONNECT_DELAY);
        },
        onError: () => this.wsLog?.close(),
      });

    } catch {
      if (this.shouldReconnectWebSockets) {
        this.reconnectTimers.log = setTimeout(
          () => this.connectLogWs(),
          WS_RECONNECT_DELAY,
        );
      }
    }
  }

  private connectTaskWs(): void {
    if (!this.shouldReconnectWebSockets) return;
    if (this.wsTask && (
      this.wsTask.readyState === WebSocket.OPEN
      || this.wsTask.readyState === WebSocket.CONNECTING
    )) return;
    try {
      this.wsTask = this.ws.connect(`${this.wsBaseUrl()}/ws/task`, {
        onMessage: data => {
          try {
            const msg = jsonCodec.parse<WsMessage>(data);
            if (msg.type === 'task_update' && this.callbacks.onTaskUpdate) this.callbacks.onTaskUpdate(msg as WsTaskUpdate);
            else if (msg.type === 'task_completed' && this.callbacks.onTaskCompleted) this.callbacks.onTaskCompleted(msg as WsTaskCompleted);
          } catch {
            Logger.debug('WS /task: malformed message', 'api');
          }
        },
        onClose: () => {
          if (!this.shouldReconnectWebSockets) return;
          Logger.debug('WS /task disconnected, reconnect in 3s', 'api');
          this.reconnectTimers.task = setTimeout(() => this.connectTaskWs(), WS_RECONNECT_DELAY);
        },
        onError: () => this.wsTask?.close(),
      });

    } catch {
      if (this.shouldReconnectWebSockets) {
        this.reconnectTimers.task = setTimeout(
          () => this.connectTaskWs(),
          WS_RECONNECT_DELAY,
        );
      }
    }
  }
}
