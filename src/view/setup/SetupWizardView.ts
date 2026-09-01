/** 渲染首次启动向导并收集模拟器和 Python 配置。 */
/**
 * SetupWizardView —— 首次运行引导向导的纯渲染组件。
 * 负责 overlay 显示/隐藏、表单预填/收集、提示信息更新。不含业务逻辑。
 */
import type { SetupWizardVO } from '../../types/view.js';

export class SetupWizardView {
  private overlay: HTMLElement;
  private emuType: HTMLSelectElement;
  private emuSerial: HTMLInputElement;
  private pythonPath: HTMLInputElement;
  private hint: HTMLElement;
  private confirmBtn: HTMLElement;
  private checkAdbBtn: HTMLElement;

  onCheckAdb?: () => void;
  onConfirm?: () => void;

  constructor() {
    this.overlay = document.getElementById('setup-wizard')!;
    this.emuType = document.getElementById('setup-emu-type') as HTMLSelectElement;
    this.emuSerial = document.getElementById('setup-emu-serial') as HTMLInputElement;
    this.pythonPath = document.getElementById('setup-python-path') as HTMLInputElement;
    this.hint = document.getElementById('setup-serial-hint')!;
    this.confirmBtn = document.getElementById('btn-setup-confirm')!;
    this.checkAdbBtn = document.getElementById('btn-setup-check-adb')!;

    this.checkAdbBtn.addEventListener('click', () => this.onCheckAdb?.());
    this.confirmBtn.addEventListener('click', () => this.onConfirm?.());
  }

  show(vo: SetupWizardVO): void {
    this.emuType.value = vo.emuType;
    this.emuSerial.value = vo.serial;
    this.pythonPath.value = vo.pythonPath;
    this.hint.textContent = '';
    this.hint.style.color = '';
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  collectValues(): { emuType: string; serial: string; pythonPath: string } {
    return {
      emuType: this.emuType.value,
      serial: this.emuSerial.value.trim(),
      pythonPath: this.pythonPath.value.trim(),
    };
  }

  setSerialHint(text: string, type: 'info' | 'error'): void {
    this.hint.textContent = text;
    this.hint.style.color = type === 'error' ? 'var(--danger, #e74c3c)' : 'var(--accent)';
  }

  setSerialValue(serial: string): void {
    this.emuSerial.value = serial;
  }

  setCheckAdbLoading(loading: boolean): void {
    this.checkAdbBtn.textContent = loading ? '检测中…' : '检测';
    (this.checkAdbBtn as HTMLButtonElement).disabled = loading;
  }

  focusSerial(): void {
    this.emuSerial.focus();
  }
}
