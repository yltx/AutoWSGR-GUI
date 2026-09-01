/** 渲染设置页运行环境状态、按钮 loading 和 GUI 更新进度。 */
import type { GuiUpdateStatus } from '../../types/ipc.js';

export type ConfigStatusKind = 'ok' | 'error' | 'unknown';

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`设置控件不存在: ${id}`);
  return target as T;
}

export class ConfigRuntimeView {
  private readonly guiUpdateProgress = element<HTMLElement>(
    'gui-update-progress',
  );
  private readonly guiUpdateStatus = element<HTMLElement>(
    'gui-update-status',
  );
  private readonly guiUpdatePercent = element<HTMLElement>(
    'gui-update-percent',
  );
  private readonly guiUpdateProgressTrack = element<HTMLElement>(
    'gui-update-progress-track',
  );
  private readonly guiUpdateProgressFill = element<HTMLElement>(
    'gui-update-progress-fill',
  );
  private readonly backendStatus = document.getElementById(
    'cfg-backend-status',
  );
  private readonly cudaStatus = document.getElementById('cfg-cuda-status');
  private readonly pythonStatus = document.getElementById('cfg-python-status');
  private readonly adbStatus = document.getElementById('cfg-adb-status');
  private readonly shipLibraryStatus = document.getElementById(
    'ship-library-status',
  );
  private readonly validateCudaButton = document.getElementById(
    'btn-validate-cuda',
  ) as HTMLButtonElement | null;
  private readonly validatePythonButton = document.getElementById(
    'btn-validate-python',
  ) as HTMLButtonElement | null;
  private readonly updateShipLibraryButton = document.getElementById(
    'btn-update-ship-library',
  ) as HTMLButtonElement | null;
  private shipLibraryUpdateLabel = '更新舰船数据库';

  setCudaStatus(
    text: string,
    status: ConfigStatusKind,
    details = text,
  ): void {
    this.setStatus(this.cudaStatus, text, status);
    if (this.cudaStatus) this.cudaStatus.title = details;
  }

  setPythonStatus(text: string, status: ConfigStatusKind): void {
    this.setStatus(this.pythonStatus, text, status);
  }

  setBackendStatus(text: string, status: ConfigStatusKind): void {
    this.setStatus(this.backendStatus, text, status);
  }

  setShipLibraryStatus(
    text: string,
    status: ConfigStatusKind,
    details = text,
  ): void {
    this.setStatus(this.shipLibraryStatus, text, status);
    if (this.shipLibraryStatus) this.shipLibraryStatus.title = details;
  }

  setShipLibraryUpdateLabel(label: string): void {
    this.shipLibraryUpdateLabel = label;
    if (
      this.updateShipLibraryButton
      && !this.updateShipLibraryButton.disabled
    ) {
      this.updateShipLibraryButton.textContent = label;
    }
  }

  setAdbStatus(
    text: string,
    status: 'online' | 'offline' | 'unknown',
  ): void {
    if (!this.adbStatus) return;
    this.adbStatus.title = text;
    this.adbStatus.textContent = status === 'online'
      ? '在线'
      : status === 'offline'
        ? '离线'
        : text.includes('中')
          ? text
          : '未检测';
    this.adbStatus.className = `adb-status adb-status-${status}`;
  }

  setCudaValidateLoading(loading: boolean): void {
    if (!this.validateCudaButton) return;
    this.validateCudaButton.disabled = loading;
    this.validateCudaButton.textContent = loading ? '检测中…' : '检测';
  }

  setPythonValidateLoading(loading: boolean): void {
    if (!this.validatePythonButton) return;
    this.validatePythonButton.disabled = loading;
    this.validatePythonButton.textContent = loading ? '检测中…' : '检测';
  }

  setShipLibraryUpdateLoading(loading: boolean): void {
    if (!this.updateShipLibraryButton) return;
    this.updateShipLibraryButton.disabled = loading;
    this.updateShipLibraryButton.textContent = loading
      ? this.shipLibraryUpdateLabel === '同步后端'
        ? '正在同步…'
        : '正在检查…'
      : this.shipLibraryUpdateLabel;
  }

  setBackendCheckLoading(loading: boolean): void {
    this.setButtonLoading('btn-check-backend', loading, '检测中…', '检测');
  }

  setAdbCheckLoading(loading: boolean): void {
    this.setButtonLoading(
      'btn-check-adb',
      loading,
      '检测中…',
      '自动检测',
    );
  }

  setAdbConnectionLoading(
    action: 'connect' | 'disconnect',
    loading: boolean,
  ): void {
    this.setButtonLoading(
      action === 'connect' ? 'btn-connect-adb' : 'btn-disconnect-adb',
      loading,
      action === 'connect' ? '连接中…' : '断开中…',
      action === 'connect' ? '主动连接' : '断开连接',
    );
  }

  setUpdateCheckLoading(loading: boolean): void {
    this.setButtonLoading(
      'btn-check-updates',
      loading,
      '检查中…',
      '立即检查',
    );
  }

  setGuiUpdateStatus(status: GuiUpdateStatus): void {
    let text: string;
    let percent: number | null = 0;
    let state: 'active' | 'complete' | 'error' = 'active';
    let percentText: string | null = null;

    switch (status.status) {
      case 'checking':
        text = '正在检查更新…';
        percent = null;
        percentText = '检查中';
        break;
      case 'available':
        text = `发现 v${status.version}，等待下载`;
        break;
      case 'up-to-date':
        text = '当前已是最新版本';
        percent = 100;
        state = 'complete';
        break;
      case 'downloading':
        percent = null;
        percentText = '后台';
        text = '正在后台下载并校验更新…';
        break;
      case 'downloaded':
        text = `v${status.version} 已准备完成，等待选择重启时间`;
        percent = 100;
        state = 'complete';
        break;
      case 'deferred':
        text = `v${status.version} 将在下次打开前更新`;
        percent = 100;
        state = 'complete';
        break;
      case 'installing':
        text = status.message;
        percent = 100;
        break;
      case 'error':
        text = `更新失败：${status.message}`;
        percentText = '失败';
        state = 'error';
        break;
    }

    this.guiUpdateProgress.hidden = false;
    this.guiUpdateProgress.dataset['state'] = state;
    this.guiUpdateProgress.title = text;
    this.guiUpdateStatus.textContent = text;
    this.guiUpdatePercent.textContent = percentText
      ?? `${percent ?? 0}%`;
    this.guiUpdateProgressTrack.classList.toggle(
      'is-indeterminate',
      percent === null,
    );
    this.guiUpdateProgressFill.style.width = `${percent ?? 0}%`;
    if (percent === null) {
      this.guiUpdateProgressTrack.removeAttribute('aria-valuenow');
    } else {
      this.guiUpdateProgressTrack.setAttribute(
        'aria-valuenow',
        String(percent),
      );
    }
  }

  private setStatus(
    target: HTMLElement | null,
    text: string,
    status: ConfigStatusKind,
  ): void {
    if (!target) return;
    target.textContent = text;
    const cls = status === 'ok'
      ? 'adb-status-online'
      : status === 'error'
        ? 'adb-status-offline'
        : 'adb-status-unknown';
    target.className = `adb-status ${cls}`;
  }

  private setButtonLoading(
    id: string,
    loading: boolean,
    loadingText: string,
    idleText: string,
  ): void {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) return;
    button.disabled = loading;
    button.textContent = loading ? loadingText : idleText;
  }
}
