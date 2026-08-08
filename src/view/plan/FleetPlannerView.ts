/** 组合舰队编辑、规则、图鉴、计划管理和编队加载视图。 */
/**
 * FleetPlannerView —— 本地舰队规划页面。
 * 读取 Electron 提供的舰船清单，负责筛选、排序、图鉴卡片和单支舰队草稿。
 * 国籍、大小和主力/护卫仅用于界面筛选，不会写入后端任务字段。
 */
import type {
  FleetDraftViewObject,
  FleetShipLibraryViewObject,
  TeamPlanListViewObject,
} from '../../types/view.js';
import type {
  BackupFollowMode,
  FleetDraftEditIntent,
  FleetDraftEditResult,
} from '../../types/fleetEditor.js';
import {
  showAlert,
  showConfirm,
  showSaveSuccess,
} from '../shared/DialogHelper';
import {
  TeamPlanLoaderView,
} from './TeamPlanLoaderView';
import {
  FleetGalleryView,
} from './FleetGalleryView';
import { FleetEditorView } from './FleetEditorView';

export interface FleetPlannerViewHost {
  loadShipLibrary(force: boolean): Promise<void>;
  loadTeamPlans(): Promise<TeamPlanListViewObject>;
  saveTeamPlan(name: string): Promise<void>;
  applyTeamPlan(planId: string): Promise<{
    success: boolean;
    error?: string;
  }>;
  getRefitFilter(): boolean;
  setRefitFilter(enabled: boolean): void;
  getBackupFollowMode(): BackupFollowMode;
  setBackupFollowMode(mode: BackupFollowMode): void;
  currentDraft(): FleetDraftViewObject;
  editDraft(intent: FleetDraftEditIntent): FleetDraftEditResult;
  setDraftName(name: string): void;
  resetDraft(): void;
  hasUnsavedDraftChanges(name: string): boolean;
}

export class FleetPlannerView {
  private readonly presetNameInput: HTMLInputElement;
  private readonly editorView: FleetEditorView;
  private readonly galleryView: FleetGalleryView;
  private readonly teamPlanLoaderView: TeamPlanLoaderView;

  constructor(private readonly host: FleetPlannerViewHost) {
    this.presetNameInput = document.getElementById(
      'fleet-preset-name',
    ) as HTMLInputElement;
    this.editorView = new FleetEditorView({
      currentDraft: () => this.currentFleet(),
      editDraft: intent => this.host.editDraft(intent),
      shipById: id => this.galleryView.shipById(id),
      colorfulBackgroundUrl: () => (
        this.galleryView.colorfulBackgroundUrl()
      ),
      shipTypeDisplay: ship => this.galleryView.shipTypeDisplay(ship),
      renderGallerySelection: () => this.galleryView.renderSelection(),
      updateGalleryCardTargets: () => (
        this.galleryView.updateCardTargets()
      ),
      getBackupFollowMode: () => this.host.getBackupFollowMode(),
      setBackupFollowMode: mode => this.host.setBackupFollowMode(mode),
    });
    this.galleryView = new FleetGalleryView({
      getRefitFilter: () => this.host.getRefitFilter(),
      setRefitFilter: enabled => this.host.setRefitFilter(enabled),
      activeSlotDescription: () => (
        this.editorView.activeSlotDescription()
      ),
      selectedShips: () => this.editorView.selectedShips(),
      assignShip: ship => this.editorView.assignShip(ship),
      rememberBackupScroll: () => (
        this.editorView.rememberBackupScroll()
      ),
      clearBackupDragScroll: () => (
        this.editorView.clearBackupDragScroll()
      ),
    });
    this.teamPlanLoaderView = new TeamPlanLoaderView({
      ensureLibrary: () => this.host.loadShipLibrary(false),
      loadPlans: () => this.host.loadTeamPlans(),
      ships: () => this.galleryView.ships(),
      colorfulBackgroundUrl: () => (
        this.galleryView.colorfulBackgroundUrl()
      ),
      shipTypeDisplay: ship => this.galleryView.shipTypeDisplay(ship),
      hasUnsavedChanges: () => this.hasUnsavedFleetChanges(),
      applyPlan: planId => this.host.applyTeamPlan(planId),
    });
    this.bindActions();
    this.editorView.render();
  }

  private bindActions(): void {
    this.presetNameInput.addEventListener('input', () => {
      this.host.setDraftName(this.presetNameInput.value);
    });

    document.getElementById('btn-save-team-plan')?.addEventListener('click', () => {
      void this.host.saveTeamPlan(this.presetNameInput.value);
    });
    document.getElementById('btn-new-team-plan')?.addEventListener('click', () => {
      void this.newTeamPlan();
    });
    document.getElementById('btn-load-team-plan')?.addEventListener('click', () => {
      void this.teamPlanLoaderView.open();
    });
  }

  private currentFleet(): FleetDraftViewObject {
    return this.host.currentDraft();
  }

  private hasUnsavedFleetChanges(): boolean {
    return this.host.hasUnsavedDraftChanges(this.presetNameInput.value);
  }

  private async newTeamPlan(): Promise<void> {
    if (this.hasUnsavedFleetChanges()) {
      const confirmed = await showConfirm(
        '新建舰队预设',
        '当前舰队编队存在未保存修改，继续新建将丢失这些修改，是否继续？',
      );
      if (!confirmed) return;
    }
    this.host.resetDraft();
    this.presetNameInput.value = '';
    this.editorView.reset();
    this.presetNameInput.focus();
  }

  showShipLibrary(library: FleetShipLibraryViewObject): void {
    this.galleryView.showLibrary(library);
  }

  showShipLibraryLoading(): void {
    this.galleryView.showLoading();
  }

  showShipLibraryError(message: string): void {
    this.galleryView.showLoadError(message);
  }

  async confirmTeamPlanOverwrite(): Promise<boolean> {
    return showConfirm('覆盖配置', '存在同名配置，是否覆盖');
  }

  showTeamPlanSaved(name: string): void {
    showSaveSuccess(`舰队方案「${name}」保存成功`);
  }

  async showTeamPlanSaveError(message: string): Promise<void> {
    await showAlert('保存失败', message);
  }

  async showTeamPlanLoadError(message: string): Promise<void> {
    await showAlert('加载失败', message);
  }

  showDraftName(name: string): void {
    this.presetNameInput.value = name;
  }

  showDraft(name: string): void {
    this.showDraftName(name);
    this.editorView.reset();
  }

  openTeamPlan(planId: string): Promise<void> {
    return this.teamPlanLoaderView.open(planId);
  }
}
