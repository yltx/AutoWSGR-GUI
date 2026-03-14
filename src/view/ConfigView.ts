/**
 * ConfigView —— 配置页纯渲染组件。
 * 接收 ConfigViewObject 填充表单，用户修改后由 Controller 收集。
 */
import type { ConfigViewObject } from './viewObjects';

export class ConfigView {
  private emuType: HTMLSelectElement;
  private emuPath: HTMLInputElement;
  private emuSerial: HTMLInputElement;
  private gameApp: HTMLSelectElement;
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
  private themeMode: HTMLSelectElement;
  private accentColor: HTMLInputElement;
  private accentLabel: HTMLElement;
  private debugMode: HTMLInputElement;

  constructor() {
    this.emuType = document.getElementById('cfg-emu-type') as HTMLSelectElement;
    this.emuPath = document.getElementById('cfg-emu-path') as HTMLInputElement;
    this.emuSerial = document.getElementById('cfg-emu-serial') as HTMLInputElement;
    this.gameApp = document.getElementById('cfg-game-app') as HTMLSelectElement;
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
    this.themeMode = document.getElementById('cfg-theme-mode') as HTMLSelectElement;
    this.accentColor = document.getElementById('cfg-accent-color') as HTMLInputElement;
    this.accentLabel = document.getElementById('cfg-accent-label')!;
    this.debugMode = document.getElementById('cfg-debug-mode') as HTMLInputElement;

    // 调色盘实时预览
    this.accentColor.addEventListener('input', () => {
      this.accentLabel.textContent = this.accentColor.value;
    });
  }

  /** 用 ViewObject 填充表单 */
  render(vo: ConfigViewObject): void {
    this.emuType.value = vo.emulatorType;
    this.emuPath.value = vo.emulatorPath;
    this.emuSerial.value = vo.emulatorSerial;
    this.gameApp.value = vo.gameApp;
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
    this.themeMode.value = vo.themeMode;
    this.accentColor.value = vo.accentColor;
    this.accentLabel.textContent = vo.accentColor;
    this.debugMode.checked = vo.debugMode;
  }

  /** 从表单收集当前值 (Controller 调用) */
  collect(): ConfigViewObject {
    return {
      emulatorType: this.emuType.value,
      emulatorPath: this.emuPath.value,
      emulatorSerial: this.emuSerial.value,
      gameApp: this.gameApp.value,
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
      themeMode: this.themeMode.value as 'dark' | 'light' | 'system',
      accentColor: this.accentColor.value,
      debugMode: this.debugMode.checked,
    };
  }
}
