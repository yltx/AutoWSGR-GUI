/**
 * ConfigView —— 配置页纯渲染组件。
 * 接收 ConfigViewObject 填充表单，用户修改后由 Controller 收集。
 */
import type { ConfigViewObject } from '../../types/view';

export class ConfigView {
  private emuType: HTMLSelectElement;
  private emuPath: HTMLInputElement;
  private emuSerial: HTMLInputElement;
  private gameApp: HTMLSelectElement;
  private updateMode: HTMLSelectElement;
  private autoExpedition: HTMLInputElement;
  private expeditionInterval: HTMLInputElement;
  private autoBattle: HTMLInputElement;
  private battleType: HTMLSelectElement;
  private autoExercise: HTMLInputElement;
  private exerciseFleetId: HTMLSelectElement;
  private battleTimes: HTMLInputElement;
  private autoNormalFight: HTMLInputElement;
  private autoDecisive: HTMLInputElement;
  private decisiveTicketReserve: HTMLInputElement;
  private decisiveTemplate: HTMLSelectElement;
  private autoLoot: HTMLInputElement;
  private lootPlan: HTMLSelectElement;
  private lootStopCount: HTMLInputElement;
  private autoExpeditionBody: HTMLElement | null;
  private autoBattleBody: HTMLElement | null;
  private autoExerciseBody: HTMLElement | null;
  private autoDecisiveBody: HTMLElement | null;
  private autoLootBody: HTMLElement | null;
  private themeMode: HTMLSelectElement;
  private accentColor: HTMLInputElement;
  private accentLabel: HTMLElement;
  private debugMode: HTMLInputElement;
  private backendPort: HTMLInputElement;
  private backendStartupMode: HTMLInputElement;
  private backendRepoPath: HTMLInputElement;
  private ocrGpuMode: HTMLSelectElement;
  private saveBackendScreenshots: HTMLInputElement;
  private debugAdvancedWrap: HTMLElement | null;
  private backendRepoWrap: HTMLElement | null;
  private pythonPath: HTMLInputElement;
  private pythonStatus: HTMLElement | null;
  private adbStatus: HTMLElement | null;
  private validatePythonBtn: HTMLButtonElement | null;

  constructor() {
    this.emuType = document.getElementById('cfg-emu-type') as HTMLSelectElement;
    this.emuPath = document.getElementById('cfg-emu-path') as HTMLInputElement;
    this.emuSerial = document.getElementById('cfg-emu-serial') as HTMLInputElement;
    this.gameApp = document.getElementById('cfg-game-app') as HTMLSelectElement;
    this.updateMode = document.getElementById('cfg-update-mode') as HTMLSelectElement;
    this.autoExpedition = document.getElementById('cfg-auto-expedition') as HTMLInputElement;
    this.expeditionInterval = document.getElementById('cfg-expedition-interval') as HTMLInputElement;
    this.autoBattle = document.getElementById('cfg-auto-battle') as HTMLInputElement;
    this.battleType = document.getElementById('cfg-battle-type') as HTMLSelectElement;
    this.autoExercise = document.getElementById('cfg-auto-exercise') as HTMLInputElement;
    this.exerciseFleetId = document.getElementById('cfg-exercise-fleet') as HTMLSelectElement;
    this.battleTimes = document.getElementById('cfg-battle-times') as HTMLInputElement;
    this.autoNormalFight = document.getElementById('cfg-auto-normal-fight') as HTMLInputElement;
    this.autoDecisive = document.getElementById('cfg-auto-decisive') as HTMLInputElement;
    this.decisiveTicketReserve = document.getElementById('cfg-decisive-ticket-reserve') as HTMLInputElement;
    this.decisiveTemplate = document.getElementById('cfg-decisive-template') as HTMLSelectElement;
    this.autoLoot = document.getElementById('cfg-auto-loot') as HTMLInputElement;
    this.lootPlan = document.getElementById('cfg-loot-plan') as HTMLSelectElement;
    this.lootStopCount = document.getElementById('cfg-loot-stop-count') as HTMLInputElement;
    this.autoExpeditionBody = document.getElementById('cfg-auto-expedition-body');
    this.autoBattleBody = document.getElementById('cfg-auto-battle-body');
    this.autoExerciseBody = document.getElementById('cfg-auto-exercise-body');
    this.autoDecisiveBody = document.getElementById('cfg-auto-decisive-body');
    this.autoLootBody = document.getElementById('cfg-auto-loot-body');
    this.themeMode = document.getElementById('cfg-theme-mode') as HTMLSelectElement;
    this.accentColor = document.getElementById('cfg-accent-color') as HTMLInputElement;
    this.accentLabel = document.getElementById('cfg-accent-label')!;
    this.debugMode = document.getElementById('cfg-debug-mode') as HTMLInputElement;
    this.backendPort = document.getElementById('cfg-backend-port') as HTMLInputElement;
    this.backendStartupMode = document.getElementById('cfg-use-external-backend') as HTMLInputElement;
    this.backendRepoPath = document.getElementById('cfg-backend-repo-path') as HTMLInputElement;
    this.ocrGpuMode = document.getElementById('cfg-ocr-gpu-mode') as HTMLSelectElement;
    this.saveBackendScreenshots = document.getElementById('cfg-save-backend-screenshots') as HTMLInputElement;
    this.debugAdvancedWrap = document.getElementById('cfg-debug-advanced');
    this.backendRepoWrap = document.getElementById('cfg-backend-repo-wrap');
    this.pythonPath = document.getElementById('cfg-python-path') as HTMLInputElement;
    this.pythonStatus = document.getElementById('cfg-python-status');
    this.adbStatus = document.getElementById('cfg-adb-status');
    this.validatePythonBtn = document.getElementById('btn-validate-python') as HTMLButtonElement | null;

    // 调色盘实时预览
    this.accentColor.addEventListener('input', () => {
      this.accentLabel.textContent = this.accentColor.value;
    });

    this.debugMode.addEventListener('change', () => {
      this.updateDebugAdvancedVisibility();
      this.updateBackendRepoVisibility();
    });

    this.backendStartupMode.addEventListener('change', () => {
      this.updateBackendRepoVisibility();
    });

    this.autoExpedition.addEventListener('change', () => this.updateAutoOptionVisibility());
    this.autoBattle.addEventListener('change', () => this.updateAutoOptionVisibility());
    this.autoExercise.addEventListener('change', () => this.updateAutoOptionVisibility());
    this.autoDecisive.addEventListener('change', () => this.updateAutoOptionVisibility());
    this.autoLoot.addEventListener('change', () => this.updateAutoOptionVisibility());

    this.updateDebugAdvancedVisibility();
    this.updateBackendRepoVisibility();
    this.updateAutoOptionVisibility();
  }

  /** 用 ViewObject 填充表单 */
  render(vo: ConfigViewObject): void {
    this.emuType.value = vo.emulatorType;
    this.emuPath.value = vo.emulatorPath;
    this.emuSerial.value = vo.emulatorSerial;
    this.gameApp.value = vo.gameApp;
    this.updateMode.value = vo.updateMode;
    this.autoExpedition.checked = vo.autoExpedition;
    this.expeditionInterval.value = String(vo.expeditionInterval);
    this.autoBattle.checked = vo.autoBattle;
    this.battleType.value = vo.battleType;
    this.autoExercise.checked = vo.autoExercise;
    this.exerciseFleetId.value = String(vo.exerciseFleetId);
    this.battleTimes.value = String(vo.battleTimes);
    this.autoNormalFight.checked = vo.autoNormalFight;
    this.autoDecisive.checked = vo.autoDecisive;
    this.decisiveTicketReserve.value = String(vo.decisiveTicketReserve);
    // 决战模板下拉列表由 Controller 填充 options
    this.decisiveTemplate.value = vo.decisiveTemplateId;
    this.autoLoot.checked = vo.autoLoot;
    this.lootPlan.value = String(vo.lootPlanIndex);
    this.lootStopCount.value = String(vo.lootStopCount);
    this.themeMode.value = vo.themeMode;
    this.accentColor.value = vo.accentColor;
    this.accentLabel.textContent = vo.accentColor;
    this.debugMode.checked = vo.debugMode;
    this.backendPort.value = String(vo.backendPort);
    this.backendStartupMode.checked = vo.backendStartupMode === 'external';
    this.backendRepoPath.value = vo.backendRepoPath;
    this.ocrGpuMode.value = vo.ocrGpuMode;
    this.saveBackendScreenshots.checked = vo.saveBackendScreenshots;
    this.pythonPath.value = vo.pythonPath;

    this.updateDebugAdvancedVisibility();
    this.updateBackendRepoVisibility();
    this.updateAutoOptionVisibility();
  }

  private updateDebugAdvancedVisibility(): void {
    if (!this.debugAdvancedWrap) return;
    const show = this.debugMode.checked;
    this.debugAdvancedWrap.style.display = show ? '' : 'none';
    if (!show && this.backendRepoWrap) {
      this.backendRepoWrap.style.display = 'none';
    }
  }

  private updateBackendRepoVisibility(): void {
    if (!this.backendRepoWrap) return;
    const show = this.debugMode.checked && this.backendStartupMode.checked;
    this.backendRepoWrap.style.display = show ? '' : 'none';
    this.backendRepoPath.required = show;
  }

  private updateAutoOptionVisibility(): void {
    if (this.autoExpeditionBody) {
      this.autoExpeditionBody.style.display = this.autoExpedition.checked ? '' : 'none';
    }
    if (this.autoBattleBody) {
      this.autoBattleBody.style.display = this.autoBattle.checked ? '' : 'none';
    }
    if (this.autoExerciseBody) {
      this.autoExerciseBody.style.display = this.autoExercise.checked ? '' : 'none';
    }
    if (this.autoDecisiveBody) {
      this.autoDecisiveBody.style.display = this.autoDecisive.checked ? '' : 'none';
    }
    if (this.autoLootBody) {
      this.autoLootBody.style.display = this.autoLoot.checked ? '' : 'none';
    }
  }

  /** 从表单收集当前值 (Controller 调用) */
  collect(): ConfigViewObject {
    return {
      emulatorType: this.emuType.value,
      emulatorPath: this.emuPath.value,
      emulatorSerial: this.emuSerial.value,
      gameApp: this.gameApp.value,
      updateMode: this.updateMode.value === 'manual' ? 'manual' : 'auto',
      autoExpedition: this.autoExpedition.checked,
      expeditionInterval: Math.max(1, Math.min(120, Number(this.expeditionInterval.value) || 15)),
      autoBattle: this.autoBattle.checked,
      battleType: this.battleType.value,
      autoExercise: this.autoExercise.checked,
      exerciseFleetId: Number(this.exerciseFleetId.value) || 1,
      battleTimes: Number(this.battleTimes.value) || 3,
      autoNormalFight: this.autoNormalFight.checked,
      autoDecisive: this.autoDecisive.checked,
      decisiveTicketReserve: Math.max(0, Number(this.decisiveTicketReserve.value) || 0),
      decisiveTemplateId: this.decisiveTemplate.value,
      autoLoot: this.autoLoot.checked,
      lootPlanIndex: Number(this.lootPlan.value) || 0,
      lootStopCount: Math.max(1, Math.min(50, Number(this.lootStopCount.value) || 50)),
      themeMode: this.themeMode.value as 'dark' | 'light' | 'system',
      accentColor: this.accentColor.value,
      debugMode: this.debugMode.checked,
      backendPort: Math.max(1, Math.min(65535, Number(this.backendPort.value) || 8438)),
      backendStartupMode: this.backendStartupMode.checked ? 'external' : 'managed',
      backendRepoPath: this.backendRepoPath.value.trim(),
      ocrGpuMode: (['auto', 'cpu', 'cuda'].includes(this.ocrGpuMode.value) ? this.ocrGpuMode.value : 'auto') as 'auto' | 'cpu' | 'cuda',
      saveBackendScreenshots: this.saveBackendScreenshots.checked,
      pythonPath: this.pythonPath.value.trim(),
    };
  }

  /* ── 单字段 setter / getter（Controller 用） ── */

  setEmulatorPath(path: string): void {
    this.emuPath.value = path;
  }

  setPythonPath(path: string): void {
    this.pythonPath.value = path;
  }

  setBackendRepoPath(path: string): void {
    this.backendRepoPath.value = path;
  }

  getPythonPath(): string {
    return this.pythonPath.value.trim();
  }

  setPythonStatus(text: string, status: 'ok' | 'error' | 'unknown'): void {
    if (!this.pythonStatus) return;
    this.pythonStatus.textContent = text;
    const cls = status === 'ok' ? 'adb-status-online' : status === 'error' ? 'adb-status-offline' : 'adb-status-unknown';
    this.pythonStatus.className = `adb-status ${cls}`;
  }

  setPythonValidateLoading(loading: boolean): void {
    if (!this.validatePythonBtn) return;
    this.validatePythonBtn.disabled = loading;
    this.validatePythonBtn.textContent = loading ? '检测中…' : '检测';
  }

  setEmulatorSerial(serial: string): void {
    this.emuSerial.value = serial;
  }

  resetAccentColor(defaultColor: string): void {
    this.accentColor.value = defaultColor;
    this.accentLabel.textContent = defaultColor;
  }

  setAdbStatus(text: string, status: 'online' | 'offline' | 'unknown'): void {
    if (!this.adbStatus) return;
    this.adbStatus.textContent = text;
    this.adbStatus.className = `adb-status adb-status-${status}`;
  }
}
