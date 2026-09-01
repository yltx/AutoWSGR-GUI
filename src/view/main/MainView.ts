/** 组合主页面状态栏、舰队、队列和日志子视图。 */
/**
 * MainView —— 主页面 Facade。
 * 持有日志、任务队列、状态栏和当前舰队四个子视图，
 * 对外 API 保持不变，Controller 无需感知内部拆分。
 */
import type { MainViewObject, LogEntryVO } from '../../types/view.js';
import { LogView } from './LogView';
import { TaskQueueView } from './TaskQueueView';
import {
  StatusBar,
  type OperationName,
} from './StatusBar';
import { FleetPreviewView } from './FleetPreviewView';

export class MainView {
  private logView: LogView;
  private taskQueueView: TaskQueueView;
  private statusBar: StatusBar;
  private fleetPreviewView: FleetPreviewView;
  private beforeUnloadHandler?: () => void;

  constructor() {
    this.logView = new LogView();
    this.taskQueueView = new TaskQueueView();
    this.statusBar = new StatusBar();
    this.fleetPreviewView = new FleetPreviewView();
    window.addEventListener('beforeunload', () => {
      this.beforeUnloadHandler?.();
    });
  }

  /* ── 回调转发（Controller 直接赋值） ── */

  set onRemoveQueueItem(fn: ((taskId: string) => void) | undefined) {
    this.taskQueueView.onRemoveQueueItem = fn;
  }
  set onMoveQueueItem(fn: ((from: number, to: number) => void) | undefined) {
    this.taskQueueView.onMoveQueueItem = fn;
  }
  set onDropFromTaskGroup(fn: ((itemIndex: number) => void) | undefined) {
    this.taskQueueView.onDropFromTaskGroup = fn;
  }
  set onEditQueueItem(fn: ((taskId: string, x: number, y: number) => void) | undefined) {
    this.taskQueueView.onEditQueueItem = fn;
  }
  set onStopTask(fn: (() => void) | undefined) {
    this.taskQueueView.onStopTask = fn;
  }
  set onClearQueue(fn: (() => void) | undefined) {
    this.taskQueueView.onClearQueue = fn;
  }
  set onImportPlan(fn: (() => void) | undefined) {
    this.taskQueueView.onImportPlan = fn;
  }
  set onStartQueue(fn: (() => void) | undefined) {
    this.taskQueueView.onStartQueue = fn;
  }
  set onOperation(
    fn: ((operation: OperationName) => void) | undefined
  ) {
    this.statusBar.onOperation = fn;
  }
  set onBeforeUnload(fn: (() => void) | undefined) {
    this.beforeUnloadHandler = fn;
  }

  /* ── 渲染 ── */

  render(vo: MainViewObject): void {
    this.statusBar.render(vo);
    this.taskQueueView.render(vo);
    this.fleetPreviewView.render(
      vo.currentFleet,
      vo.currentTask !== null,
      vo.dailySortieStats,
    );
  }

  appendLog(entry: LogEntryVO): void {
    this.logView.appendLog(entry);
  }

  setDebugMode(on: boolean): void {
    this.logView.setDebugMode(on);
  }

  /* ── 状态 / 日常操作 ── */

  setOpsAvailability(connected: boolean): void {
    this.statusBar.setOpsAvailability(connected);
  }

  setOpsStatus(text: string): void {
    this.statusBar.setOpsStatus(text);
  }

  setOperationLoading(
    operation: OperationName,
    loading: boolean,
  ): void {
    this.statusBar.setOperationLoading(operation, loading);
  }

  setExpeditionTimer(text: string): void {
    this.statusBar.setExpeditionTimer(text);
  }

  setVersion(v: string): void {
    this.statusBar.setVersion(v);
  }
}
