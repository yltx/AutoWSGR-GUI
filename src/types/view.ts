/** 定义 Controller 交给各页面渲染的 ViewObject、表单值和展示状态。 */

import type {
  PlanPresetSource,
  ShipLibraryLabels,
  ShipLibraryShip,
} from './ipc.js';
import type {
  EventMapCatalogEntry,
  NormalFightTaskConfig,
} from './model.js';
import type { DailySortieStatsSnapshot } from './statistics.js';
import type {
  LootAutomationPlan,
  LootPlanSource,
} from '../shared/lootPlans.js';
import type {
  DecisiveAutomationSource,
} from '../shared/decisiveAutomation.js';

export interface ConfigViewObject {
  emulatorType: string;
  emulatorPath: string;
  emulatorSerial: string;
  gameApp: string;
  updateMode: 'auto' | 'manual';
  backendUpdateMode: 'auto' | 'manual';
  allowTestUpdates: boolean;
  autoExpedition: boolean;
  expeditionInterval: number;
  autoBattle: boolean;
  battleType: string;
  autoExercise: boolean;
  exerciseFleetId: number;
  battleTimes: number;
  autoNormalFight: boolean;
  normalFightTasks: NormalFightTaskConfig[];
  normalFightRemaining: number | null;
  autoDecisive: boolean;
  decisiveTemplateId: DecisiveAutomationSource;
  autoLoot: boolean;
  lootPlanSource: LootPlanSource;
  lootPlanId: string;
  lootPlans: LootAutomationPlan[];
  lootStopCount: number;
  logLevel: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  logRoot: string;
  /** GUI 日志文件目录（相对配置目录或绝对路径），默认 "logs"。 */
  guiLogRoot: string;
  themeMode: 'dark' | 'light' | 'system';
  accentColor: string;
  debugMode: boolean;
  backendPort: number;
  backendStartupMode: 'managed' | 'external';
  backendRepoPath: string;
  ocrGpuMode: 'auto' | 'cpu' | 'cuda';
  ocrGpu: boolean;
  ocrMirror: 'origin' | 'github' | 'tencent' | 'modelscope';
  enhancedShipOcr: boolean;
  ocrConfidence: number;
  shipNameAliasesText: string;
  shipNameCorrectionsText: string;
  cudaPath: string;
  saveBackendScreenshots: boolean;
  pythonPath: string;
  defaultWindowWidth: number;
  defaultWindowHeight: number;
  rememberWindowBounds: boolean;
  operationDelayMin: number;
  operationDelayMax: number;
  dockFullDestroy: boolean;
  repairManually: boolean;
  bathroomCount: number;
  destroyShipWorkMode: number;
  destroyShipTypes: string[];
  removeEquipmentMode: boolean;
  planRoot: string;
}

export type AppStatus =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'error'
  | 'not_connected';

export interface CurrentFleetShipVO {
  readonly name: string;
  readonly ship?: ShipLibraryShip;
  readonly shipTypeLabel?: string;
}

export interface MainViewObject {
  status: AppStatus;
  statusText: string;
  currentTask: TaskViewObject | null;
  currentFleet: CurrentFleetShipVO[];
  dailySortieStats: DailySortieStatsSnapshot;
  expeditionTimer: string;
  taskQueue: TaskQueueItemVO[];
  wsConnected: boolean;
  runningTaskId: string | null;
}

export interface TaskViewObject {
  name: string;
  type:
    | 'normal_fight'
    | 'event_fight'
    | 'campaign'
    | 'exercise'
    | 'expedition'
    | 'decisive';
  progress: string;
  startedAt: string;
}

export interface TaskQueueItemVO {
  id: string;
  name: string;
  priorityLabel: string;
  remaining: number;
  totalTimes: number;
  unlimited?: boolean;
  /** 任务正在轮次间隔或失败重试倒计时中。 */
  waiting?: boolean;
  waitingText?: string;
  progress?: string;
  progressPercent?: number;
  acquisitionText?: string;
}

export interface LogEntryVO {
  time: string;
  level: string;
  channel: string;
  message: string;
}

export interface FleetRuleDraftViewObject {
  readonly shipTypes: readonly string[];
  readonly levelEnabled: boolean;
  readonly minLevel: number | null;
  readonly maxLevel: number | null;
  readonly relaxed: boolean;
}

export interface FleetCandidateDraftViewObject
  extends FleetRuleDraftViewObject {
  readonly ship: ShipLibraryShip | null;
}

export interface FleetSlotDraftViewObject
  extends FleetRuleDraftViewObject {
  readonly primary: ShipLibraryShip | null;
  readonly candidates: readonly FleetCandidateDraftViewObject[];
}

export interface FleetDraftViewObject {
  readonly name: string;
  readonly slots: readonly FleetSlotDraftViewObject[];
}

export interface FleetShipLibraryViewObject {
  labels: ShipLibraryLabels;
  ships: ShipLibraryShip[];
  colorfulBackgroundUrl: string;
}

export interface ShipGalleryViewState {
  searchText: string;
  groupFilter: string | null;
  typeFilters: string[];
  countryFilters: string[];
  refitOnly: boolean;
  sortField: 'type' | 'name' | 'id';
  descending: boolean;
  scrollTop: number;
  scrollLeft: number;
  renderedShipCount: number;
}

export interface TeamPlanShipRuleViewObject {
  name: string;
  searchName?: string;
  shipTypes: string[];
  minLevel?: number;
  maxLevel?: number;
}

export interface TeamPlanSlotViewObject {
  primary?: TeamPlanShipRuleViewObject;
  candidates: TeamPlanShipRuleViewObject[];
}

export interface TeamPlanViewObject {
  id: string;
  name: string;
  source: PlanPresetSource;
  modifiedAt?: number;
  selected: boolean;
  ships: TeamPlanSlotViewObject[];
}

export interface TeamPlanListViewObject {
  plans: TeamPlanViewObject[];
  errorCount: number;
}

export interface PlanManagementErrorViewObject {
  readonly source: PlanPresetSource;
  readonly file: string;
  readonly message: string;
}

export interface PlanManagementRowViewObject {
  readonly kind: 'battle' | 'team';
  readonly source: PlanPresetSource;
  readonly name: string;
  readonly file: string;
  readonly relations: readonly string[];
  readonly taskGroups: readonly string[];
  readonly missingRelations: readonly string[];
  readonly status: string;
  readonly statusClass: 'ok' | 'warning' | 'muted';
  readonly attention: boolean;
  readonly ignoredUnlinked?: boolean;
  readonly invalid?: boolean;
  readonly errorMessage?: string;
  readonly deleteWarning?: string;
}

export interface PlanManagementViewObject {
  readonly rows: readonly PlanManagementRowViewObject[];
  readonly errors: readonly PlanManagementErrorViewObject[];
}

export type MapNodeType =
  | 'Start'
  | 'Normal'
  | 'Boss'
  | 'Resource'
  | 'Penalty'
  | 'Suppress'
  | 'Aerial'
  | 'Hard';

export interface NodeViewObject {
  id: string;
  formation: string;
  night: boolean;
  proceed: boolean;
  hasCustomRules: boolean;
  note: string;
  nodeType: MapNodeType;
  detour: boolean;
  mapNight: boolean;
  position?: [number, number];
}

export interface MapEdgeVO {
  from: [number, number];
  to: [number, number];
  fromId: string;
  toId: string;
}

export interface PlanPreviewViewObject {
  fileName: string;
  chapter: number | string;
  map: number | string;
  mapName: string;
  event?: string;
  eventMaps: EventMapCatalogEntry[];
  repairModeValue: number;
  fightConditionValue: number;
  fleetId: number;
  selectedNodes: NodeViewObject[];
  comment: string;
  allNodes?: NodeViewObject[];
  edges?: MapEdgeVO[];
  mapAspectRatio?: number;
  fleetPresetSelector: PlanFleetPresetSelectorViewObject;
  times?: number;
  gap?: number;
  lootCountGe?: number;
  shipCountGe?: number;
  collectResultInfo?: boolean;
}

export type FleetPresetCatalogStatus = 'loading' | 'ready' | 'error';

export interface PlanFleetPresetBindingViewObject {
  readonly index: number;
  readonly catalogPlanId?: string;
  readonly name: string;
  readonly source: PlanPresetSource | 'deleted';
  readonly modifiedAt?: number;
  readonly ships: readonly TeamPlanSlotViewObject[];
}

export interface PlanFleetPresetSelectorViewObject {
  readonly status: FleetPresetCatalogStatus;
  readonly message: string;
  readonly errorCount: number;
  readonly plans: readonly TeamPlanViewObject[];
  readonly bindings: readonly PlanFleetPresetBindingViewObject[];
  readonly shipLibrary: FleetShipLibraryViewObject | null;
}

export interface SetupWizardVO {
  emuType: string;
  serial: string;
  pythonPath: string;
}

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

export interface TaskGroupItemViewObject {
  path?: string;
  managedSource?: PlanPresetSource;
  managedFile?: string;
  dailySource?: PlanPresetSource;
  dailyFile?: string;
  dailyTaskType?: 'exercise' | 'campaign' | 'decisive';
  templateId?: string;
  kind: 'plan' | 'preset' | 'template' | 'daily';
  times: number;
  label: string;
}

export interface TaskGroupItemMeta {
  mapName?: string;
  fleetId?: number;
  repairMode?: string;
  typeLabel?: string;
  fleet?: string[];
  fleetPresetName?: string;
}

export interface TaskGroupViewObject {
  groups: ReadonlyArray<{ name: string; itemCount: number }>;
  activeGroupName: string;
  items: ReadonlyArray<TaskGroupItemViewObject>;
  itemMetas?: ReadonlyArray<TaskGroupItemMeta | null>;
}

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

export interface WizardFormData {
  type: string;
  name: string;
  defaultTimes: number;
  stopLoot: number;
  stopShip: number;
  planPath?: string;
  fleetId?: number;
  fleetNf?: string[];
  exerciseFleetId?: number;
  fleetEx?: string[];
  campaignName?: string;
  fleetCp?: string[];
  chapter?: number;
  level1?: string[];
  level2?: string[];
  flagshipPriority?: string[];
  useQuickRepair?: boolean;
}

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
  defaultStopCondition?: {
    loot_count_ge?: number;
    ship_count_ge?: number;
  };
}

export interface SelectorOption {
  icon: string;
  label: string;
  sublabel?: string;
}
