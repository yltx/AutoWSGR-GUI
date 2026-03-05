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
  private autoBattle: HTMLInputElement;
  private battleType: HTMLSelectElement;
  private autoExercise: HTMLInputElement;
  private themeMode: HTMLSelectElement;
  private accentColor: HTMLInputElement;
  private accentLabel: HTMLElement;

  constructor() {
    this.emuType = document.getElementById('cfg-emu-type') as HTMLSelectElement;
    this.emuPath = document.getElementById('cfg-emu-path') as HTMLInputElement;
    this.emuSerial = document.getElementById('cfg-emu-serial') as HTMLInputElement;
    this.gameApp = document.getElementById('cfg-game-app') as HTMLSelectElement;
    this.autoExpedition = document.getElementById('cfg-auto-expedition') as HTMLInputElement;
    this.autoBattle = document.getElementById('cfg-auto-battle') as HTMLInputElement;
    this.battleType = document.getElementById('cfg-battle-type') as HTMLSelectElement;
    this.autoExercise = document.getElementById('cfg-auto-exercise') as HTMLInputElement;
    this.themeMode = document.getElementById('cfg-theme-mode') as HTMLSelectElement;
    this.accentColor = document.getElementById('cfg-accent-color') as HTMLInputElement;
    this.accentLabel = document.getElementById('cfg-accent-label')!;

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
    this.autoBattle.checked = vo.autoBattle;
    this.battleType.value = vo.battleType;
    this.autoExercise.checked = vo.autoExercise;
    this.themeMode.value = vo.themeMode;
    this.accentColor.value = vo.accentColor;
    this.accentLabel.textContent = vo.accentColor;
  }

  /** 从表单收集当前值 (Controller 调用) */
  collect(): ConfigViewObject {
    return {
      emulatorType: this.emuType.value,
      emulatorPath: this.emuPath.value,
      emulatorSerial: this.emuSerial.value,
      gameApp: this.gameApp.value,
      autoExpedition: this.autoExpedition.checked,
      autoBattle: this.autoBattle.checked,
      battleType: this.battleType.value,
      autoExercise: this.autoExercise.checked,
      themeMode: this.themeMode.value as 'dark' | 'light' | 'system',
      accentColor: this.accentColor.value,
    };
  }
}
