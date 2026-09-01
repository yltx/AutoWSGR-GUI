/**
 * 读取、归一化并保存 GUI 业务设置。
 */
import { GuiSettingsStore } from './GuiSettingsStore';
import {
  DEFAULT_LOOT_PLAN_ID,
  DEFAULT_LOOT_PLANS,
  INTERIM_LOOT_PLAN_IDS,
  findLootAutomationPlan,
  lootPlanIdFromIndex,
  normalizeLootAutomationPlans,
  type LootAutomationPlan,
  type LootPlanSource,
} from '../../src/shared/lootPlans';
import type {
  LegacyDecisiveAutomationSettings,
} from '../../src/shared/legacyDecisiveAutomation';
import {
  normalizeDecisiveAutomationSource,
  type DecisiveAutomationSource,
} from '../../src/shared/decisiveAutomation';
import { DAILY_CAMPAIGN_TIMES } from '../../src/shared/campaign';
import {
  DEFAULT_DECISIVE_PLAN_SETTINGS,
  type DecisivePlanSettings,
} from '../../src/shared/decisivePlan';
import type {
  GuiSettingsCommitRequest,
} from '../../src/types/ipc';

export type BackendStartupMode = 'managed' | 'external';
export type OcrGpuMode = 'auto' | 'cpu' | 'cuda';
export type UpdateMode = 'auto' | 'manual';

export interface GuiAutomationSettings {
  expeditionInterval: number;
  /** 兼容持久化结构，自动战役运行时固定为 8。 */
  battleTimes: number;
  autoDecisive: boolean;
  decisiveTemplateId: DecisiveAutomationSource;
  autoLoot: boolean;
  lootPlanSource: LootPlanSource;
  lootPlanId: string;
  lootPlans: LootAutomationPlan[];
  lootStopCount: number;
}

export interface GuiConfigurationDependencies {
  clearPythonCache(): void;
  normalizeCudaPath(candidate: string): string;
  environmentPort?(): string | undefined;
  defaultAllowTestUpdates?(): boolean;
}

/** 只接受有限数字或非空数字字符串，避免把 null/false 当成 0。 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 解释 GUI 设置字段并执行原有归一化和迁移规则。 */
export class GuiConfigurationService {
  constructor(
    private readonly store: GuiSettingsStore,
    private readonly dependencies: GuiConfigurationDependencies,
  ) {}

  /** 返回启动时使用的后端端口。 */
  backendPort(): number {
    const environmentPort = this.dependencies.environmentPort?.();
    if (environmentPort) {
      return parseInt(environmentPort, 10);
    }
    const settings = this.store.read();
    if (
      typeof settings.backend_port === 'number'
      && settings.backend_port > 0
      && settings.backend_port < 65536
    ) {
      return settings.backend_port;
    }
    return 8438;
  }

  /** 仅在端口是合法有限整数时写入。 */
  setBackendPort(port: number): void {
    if (typeof port !== 'number' || !Number.isFinite(port)) return;
    const normalized = Math.trunc(port);
    if (normalized < 1 || normalized > 65535) return;
    this.store.write({ backend_port: normalized });
  }

  /** 返回用户指定的 Python 路径；空值表示自动检测。 */
  configuredPythonPath(): string | null {
    const settings = this.store.read();
    if (
      typeof settings.python_path === 'string'
      && settings.python_path.length > 0
    ) {
      return settings.python_path;
    }
    return null;
  }

  /** 保存 Python 路径并清除 Python 发现缓存。 */
  setPythonPath(pythonPath: string | null): void {
    this.store.write({ python_path: pythonPath ?? '' });
    this.dependencies.clearPythonCache();
  }

  /** 返回 autowsgr 更新模式。 */
  updateMode(): UpdateMode {
    return this.store.read().update_mode === 'manual'
      ? 'manual'
      : 'auto';
  }

  /** 保存归一化后的 autowsgr 更新模式。 */
  setUpdateMode(mode: UpdateMode): void {
    this.store.write({
      update_mode: mode === 'manual' ? 'manual' : 'auto',
    });
  }

  /** 是否允许 stable 客户端接收更高版本的 alpha 更新。 */
  allowTestUpdates(): boolean {
    const settings = this.store.read();
    if (typeof settings.allow_test_updates === 'boolean') {
      return settings.allow_test_updates;
    }
    return this.dependencies.defaultAllowTestUpdates?.() === true;
  }

  /** 返回 managed 或 external 后端启动模式。 */
  backendStartupMode(): BackendStartupMode {
    return this.store.read().backend_startup_mode === 'external'
      ? 'external'
      : 'managed';
  }

  /** 保存归一化后的后端启动模式。 */
  setBackendStartupMode(mode: BackendStartupMode): void {
    this.store.write({
      backend_startup_mode: mode === 'external'
        ? 'external'
        : 'managed',
    });
  }

  /** 返回去除首尾空白的 external 后端仓库路径。 */
  backendRepoPath(): string {
    const value = this.store.read().backend_repo_path;
    return typeof value === 'string' ? value.trim() : '';
  }

  /** 保存去除首尾空白的 external 后端仓库路径。 */
  setBackendRepoPath(repoPath: string | null): void {
    this.store.write({
      backend_repo_path: typeof repoPath === 'string'
        ? repoPath.trim()
        : '',
    });
  }

  /** 返回 OCR GPU 模式。 */
  ocrGpuMode(): OcrGpuMode {
    const value = this.store.read().ocr_gpu_mode;
    return value === 'cpu' || value === 'cuda' ? value : 'auto';
  }

  /** 保存归一化后的 OCR GPU 模式。 */
  setOcrGpuMode(mode: OcrGpuMode): void {
    this.store.write({
      ocr_gpu_mode: mode === 'cpu' || mode === 'cuda'
        ? mode
        : 'auto',
    });
  }

  /** 返回去除首尾空白的 CUDA 配置路径。 */
  cudaPath(): string {
    const value = this.store.read().cuda_path;
    return typeof value === 'string' ? value.trim() : '';
  }

  /** 保存空路径或统一归一化后的 CUDA 路径。 */
  setCudaPath(cudaPath: string | null): void {
    const raw = typeof cudaPath === 'string'
      ? cudaPath.trim()
      : '';
    this.store.write({
      cuda_path: raw
        ? this.dependencies.normalizeCudaPath(raw)
        : '',
    });
  }

  /** 返回是否保存后端异常截图。 */
  saveBackendScreenshots(): boolean {
    return this.store.read().save_backend_screenshots === true;
  }

  /** 保存后端异常截图开关。 */
  setSaveBackendScreenshots(enabled: boolean): void {
    this.store.write({
      save_backend_screenshots: enabled === true,
    });
  }

  /** 读取已有的 GUI 自动化字段，不为缺失字段补默认值。 */
  automation(): {
    exists: boolean;
    settings: Partial<GuiAutomationSettings>;
  } {
    const raw = this.store.read().automation;
    const hasAutomation = !!raw
      && typeof raw === 'object'
      && !Array.isArray(raw);
    const value = hasAutomation
      ? raw as Record<string, unknown>
      : {};
    const settings: Partial<GuiAutomationSettings> = {};
    const legacyDecisive = this.legacyDecisiveAutomation().settings;
    let rewritten: Record<string, unknown> | null = null;
    const expeditionInterval = finiteNumber(value.expeditionInterval);
    if (expeditionInterval !== null) {
      settings.expeditionInterval = expeditionInterval;
    }
    const battleTimes = finiteNumber(value.battleTimes);
    if (battleTimes !== null) {
      settings.battleTimes = DAILY_CAMPAIGN_TIMES;
      if (battleTimes !== DAILY_CAMPAIGN_TIMES) {
        rewritten = {
          ...(rewritten ?? value),
          battleTimes: DAILY_CAMPAIGN_TIMES,
        };
      }
    }
    if (typeof value.autoDecisive === 'boolean') {
      settings.autoDecisive = value.autoDecisive;
    } else if (typeof legacyDecisive.autoDecisive === 'boolean') {
      settings.autoDecisive = legacyDecisive.autoDecisive;
      rewritten = {
        ...(rewritten ?? value),
        autoDecisive: legacyDecisive.autoDecisive,
      };
    }
    const storedDecisiveSource = (
      typeof value.decisiveTemplateId === 'string'
        ? value.decisiveTemplateId.trim()
        : legacyDecisive.templateId
    );
    if (storedDecisiveSource) {
      const normalizedSource = normalizeDecisiveAutomationSource(
        storedDecisiveSource,
      );
      settings.decisiveTemplateId = normalizedSource;
      if (storedDecisiveSource !== normalizedSource) {
        rewritten = {
          ...(rewritten ?? value),
          decisiveTemplateId: normalizedSource,
        };
      }
    }
    if (typeof value.autoLoot === 'boolean') {
      settings.autoLoot = value.autoLoot;
    }
    const hasStoredLootPlans = Array.isArray(value.lootPlans);
    const lootPlans = normalizeLootAutomationPlans(value.lootPlans);
    if (hasStoredLootPlans) {
      settings.lootPlans = lootPlans;
      if (JSON.stringify(value.lootPlans) !== JSON.stringify(lootPlans)) {
        rewritten = {
          ...(rewritten ?? value),
          lootPlans,
        };
      }
    }
    const lootPlanSource: LootPlanSource = (
      value.lootPlanSource === 'user' ? 'user' : 'system'
    );
    if (typeof value.lootPlanId === 'string') {
      const selected = findLootAutomationPlan(
        lootPlans,
        lootPlanSource,
        value.lootPlanId,
      );
      if (selected) {
        settings.lootPlanSource = selected.source;
        settings.lootPlanId = selected.file;
        if (
          selected.source !== value.lootPlanSource
          || selected.file !== value.lootPlanId
        ) {
          rewritten = {
            ...(rewritten ?? value),
            lootPlanSource: selected.source,
            lootPlanId: selected.file,
          };
        }
      } else {
        settings.autoLoot = false;
        rewritten = {
          ...(rewritten ?? value),
          autoLoot: false,
        };
      }
    } else if (
      Object.prototype.hasOwnProperty.call(value, 'lootPlanIndex')
    ) {
      const resolved = lootPlanIdFromIndex(
        value.lootPlanIndex,
        INTERIM_LOOT_PLAN_IDS,
      );
      rewritten = { ...(rewritten ?? value) };
      delete rewritten.lootPlanIndex;
      if (resolved) {
        settings.lootPlanSource = 'system';
        settings.lootPlanId = resolved;
        rewritten.lootPlanSource = 'system';
        rewritten.lootPlanId = resolved;
      } else {
        settings.autoLoot = false;
        rewritten.autoLoot = false;
      }
    } else if (
      Object.prototype.hasOwnProperty.call(value, 'lootPlanId')
    ) {
      settings.autoLoot = false;
      rewritten = {
        ...(rewritten ?? value),
        autoLoot: false,
      };
    }
    const lootStopCount = finiteNumber(value.lootStopCount);
    if (lootStopCount !== null) {
      settings.lootStopCount = lootStopCount;
    }
    if (rewritten) {
      this.store.write({ automation: rewritten });
    }
    return {
      exists: hasAutomation || Object.keys(settings).length > 0,
      settings,
    };
  }

  /** 归一化并保存 GUI 自动化字段。 */
  setAutomation(
    settings: GuiAutomationSettings,
  ): GuiAutomationSettings {
    const normalized = this.normalizeAutomation(settings);
    this.store.write({
      automation: this.mergeAutomationSettings(normalized),
    });
    return normalized;
  }

  /**
   * 归一化设置页的全部 GUI 设置并合并为一次原子 JSON 写入。
   * usersettings.yaml 由 GuiSettingsCommitService 负责写入和失败恢复。
   */
  commitSettings(
    settings: GuiSettingsCommitRequest,
    additionalPatch: Record<string, unknown>,
  ): GuiAutomationSettings {
    if (
      typeof settings.backendPort !== 'number'
      || !Number.isFinite(settings.backendPort)
      || settings.backendPort < 1
      || settings.backendPort > 65535
    ) {
      throw new Error('后端端口必须是 1 到 65535 的整数');
    }
    if (
      settings.backendStartupMode === 'external'
      && !settings.backendRepoPath?.trim()
    ) {
      throw new Error('使用本地后端时必须配置仓库路径');
    }
    const normalizedAutomation = this.normalizeAutomation(
      settings.automation,
    );
    const rawCudaPath = typeof settings.cudaPath === 'string'
      ? settings.cudaPath.trim()
      : '';
    const patch: Record<string, unknown> = {
      ...additionalPatch,
      update_mode: settings.updateMode === 'manual' ? 'manual' : 'auto',
      allow_test_updates: settings.allowTestUpdates === true,
      backend_port: Math.trunc(settings.backendPort),
      backend_startup_mode: settings.backendStartupMode === 'external'
        ? 'external'
        : 'managed',
      backend_repo_path: typeof settings.backendRepoPath === 'string'
        ? settings.backendRepoPath.trim()
        : '',
      ocr_gpu_mode: (
        settings.ocrGpuMode === 'cpu'
        || settings.ocrGpuMode === 'cuda'
      )
        ? settings.ocrGpuMode
        : 'auto',
      cuda_path: rawCudaPath
        ? this.dependencies.normalizeCudaPath(rawCudaPath)
        : '',
      save_backend_screenshots:
        settings.saveBackendScreenshots === true,
      python_path: settings.pythonPath ?? '',
      automation: this.mergeAutomationSettings(normalizedAutomation),
    };
    this.dependencies.clearPythonCache();
    this.store.write(patch);
    return normalizedAutomation;
  }

  /** 归一化 GUI 自动化设置，但不执行持久化。 */
  private normalizeAutomation(
    settings: GuiAutomationSettings,
  ): GuiAutomationSettings {
    const lootPlans = normalizeLootAutomationPlans(settings?.lootPlans);
    const requestedSource: LootPlanSource = (
      settings?.lootPlanSource === 'user' ? 'user' : 'system'
    );
    const selected = findLootAutomationPlan(
      lootPlans,
      requestedSource,
      settings?.lootPlanId,
    );
    const fallback = lootPlans[0] ?? DEFAULT_LOOT_PLANS[0];
    const decisiveTemplateId = normalizeDecisiveAutomationSource(
      settings?.decisiveTemplateId,
    );
    const normalized: GuiAutomationSettings = {
      expeditionInterval: Math.max(
        1,
        Math.min(
          120,
          Math.trunc(Number(settings?.expeditionInterval) || 15),
        ),
      ),
      battleTimes: DAILY_CAMPAIGN_TIMES,
      autoDecisive: settings?.autoDecisive === true,
      decisiveTemplateId,
      autoLoot: settings?.autoLoot === true && selected !== null,
      lootPlanSource: selected?.source ?? fallback?.source ?? 'system',
      lootPlanId: selected?.file ?? fallback?.file ?? DEFAULT_LOOT_PLAN_ID,
      lootPlans,
      lootStopCount: Math.max(
        1,
        Math.min(
          50,
          Math.trunc(Number(settings?.lootStopCount) || 50),
        ),
      ),
    };
    return normalized;
  }

  /** 保留 automation 中尚未建模的字段并覆盖已归一化字段。 */
  private mergeAutomationSettings(
    normalized: GuiAutomationSettings,
  ): Record<string, unknown> {
    const raw = this.store.read().automation;
    const output: Record<string, unknown> = (
      raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...raw as Record<string, unknown>, ...normalized }
      : { ...normalized }
    );
    delete output.lootPlanIndex;
    return output;
  }

  /** 读取已经保留到 GUI JSON 的旧版决战自动化原值。 */
  legacyDecisiveAutomation(): {
    exists: boolean;
    settings: LegacyDecisiveAutomationSettings;
  } {
    const raw = this.store.read().legacy_decisive_automation;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { exists: false, settings: {} };
    }
    const value = raw as Record<string, unknown>;
    const settings: LegacyDecisiveAutomationSettings = {};
    if (typeof value.auto_decisive === 'boolean') {
      settings.autoDecisive = value.auto_decisive;
    }
    if (
      typeof value.decisive_ticket_reserve === 'number'
      && Number.isFinite(value.decisive_ticket_reserve)
    ) {
      settings.ticketReserve = value.decisive_ticket_reserve;
    }
    if (
      typeof value.decisive_template_id === 'string'
      && value.decisive_template_id.length > 0
    ) {
      settings.templateId = value.decisive_template_id;
    }
    return { exists: true, settings };
  }

  /**
   * 原样归档旧版决战设置；开关和模板由 automation() 升级。
   * 写入后立即回读并逐字段校验，失败时由调用方保留 YAML 原字段。
   */
  migrateLegacyDecisiveAutomation(
    settings: LegacyDecisiveAutomationSettings,
  ): LegacyDecisiveAutomationSettings {
    const fields = [
      'autoDecisive',
      'ticketReserve',
      'templateId',
    ] as const;
    const supplied = fields.filter(field => (
      Object.prototype.hasOwnProperty.call(settings, field)
    ));
    if (supplied.length === 0) {
      throw new Error('没有可迁移的旧版决战配置');
    }
    if (
      supplied.includes('autoDecisive')
      && typeof settings.autoDecisive !== 'boolean'
    ) {
      throw new Error('auto_decisive 必须是布尔值');
    }
    if (
      supplied.includes('ticketReserve')
      && (
        typeof settings.ticketReserve !== 'number'
        || !Number.isFinite(settings.ticketReserve)
      )
    ) {
      throw new Error('decisive_ticket_reserve 必须是有限数字');
    }
    if (
      supplied.includes('templateId')
      && (
        typeof settings.templateId !== 'string'
        || settings.templateId.length === 0
      )
    ) {
      throw new Error('decisive_template_id 必须是非空文字');
    }

    const current = this.store.read().legacy_decisive_automation;
    const output = current
      && typeof current === 'object'
      && !Array.isArray(current)
      ? { ...current as Record<string, unknown> }
      : {};
    if (supplied.includes('autoDecisive')) {
      output.auto_decisive = settings.autoDecisive;
    }
    if (supplied.includes('ticketReserve')) {
      output.decisive_ticket_reserve = settings.ticketReserve;
    }
    if (supplied.includes('templateId')) {
      output.decisive_template_id = settings.templateId;
    }
    this.store.write({ legacy_decisive_automation: output });

    const verified = this.legacyDecisiveAutomation();
    for (const field of supplied) {
      if (
        !verified.exists
        || verified.settings[field] !== settings[field]
      ) {
        throw new Error(`旧版决战配置回读校验失败: ${field}`);
      }
    }
    return verified.settings;
  }

  /** 读取决战计划，并在发现旧字段时原地迁移。 */
  decisivePlan(): DecisivePlanSettings {
    const rawPlan = this.store.read().decisive_plan;
    const normalized = this.normalizeDecisivePlan(rawPlan);
    if (
      rawPlan
      && typeof rawPlan === 'object'
      && !Array.isArray(rawPlan)
      && (
        Object.prototype.hasOwnProperty.call(rawPlan, 'level3')
        || (
          Array.isArray(
            (rawPlan as Record<string, unknown>).level1,
          )
          && (
            (rawPlan as Record<string, unknown>)
              .level1 as unknown[]
          ).length > 6
        )
      )
    ) {
      this.writeDecisivePlan(normalized);
    }
    return normalized;
  }

  /** 归一化并保存决战计划。 */
  setDecisivePlan(
    settings: DecisivePlanSettings,
  ): DecisivePlanSettings {
    const normalized = this.normalizeDecisivePlan(settings);
    this.writeDecisivePlan(normalized);
    return normalized;
  }

  /** 归一化决战章节、修理设置和两级舰船列表。 */
  private normalizeDecisivePlan(
    value: unknown,
  ): DecisivePlanSettings {
    const raw = value
      && typeof value === 'object'
      && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const chapter = Math.trunc(Number(raw.chapter));
    const requestedMainShips = this.normalizeDecisiveShips(
      raw.level1,
      DEFAULT_DECISIVE_PLAN_SETTINGS.level1,
    );
    const mainShips = requestedMainShips.slice(0, 6);
    const requestedBackupShips = this.normalizeDecisiveShips(
      raw.level2,
      DEFAULT_DECISIVE_PLAN_SETTINGS.level2,
    );
    const legacyLevel3 = Array.isArray(raw.level3)
      ? this.normalizeDecisiveShips(raw.level3, [])
      : [];
    const backupShips: string[] = [];
    for (
      const name of [
        ...requestedMainShips.slice(6),
        ...requestedBackupShips,
        ...legacyLevel3,
      ]
    ) {
      if (
        !mainShips.includes(name)
        && !backupShips.includes(name)
      ) {
        backupShips.push(name);
      }
    }
    return {
      chapter: Number.isFinite(chapter)
        ? Math.max(1, Math.min(6, chapter))
        : DEFAULT_DECISIVE_PLAN_SETTINGS.chapter,
      useQuickRepair: typeof raw.use_quick_repair === 'boolean'
        ? raw.use_quick_repair
        : typeof raw.useQuickRepair === 'boolean'
          ? raw.useQuickRepair
          : DEFAULT_DECISIVE_PLAN_SETTINGS.useQuickRepair,
      level1: mainShips,
      level2: backupShips,
    };
  }

  /** 清理舰船名、长度和重复项。 */
  private normalizeDecisiveShips(
    value: unknown,
    fallback: string[],
  ): string[] {
    if (!Array.isArray(value)) return [...fallback];
    return value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter((item, index, values) => (
        item.length > 0
        && item.length <= 80
        && values.indexOf(item) === index
      ));
  }

  /** 使用兼容的 snake_case 结构写回决战计划。 */
  private writeDecisivePlan(settings: DecisivePlanSettings): void {
    this.store.write({
      decisive_plan: {
        chapter: settings.chapter,
        use_quick_repair: settings.useQuickRepair,
        level1: settings.level1,
        level2: settings.level2,
      },
    });
  }
}
