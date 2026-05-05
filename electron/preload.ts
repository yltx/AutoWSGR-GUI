/**
 * Preload 脚本 —— 通过 contextBridge 安全暴露 IPC 方法给渲染进程。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronBridge', {
  getAppVersion: () => {
    return ipcRenderer.sendSync('get-app-version-sync') as string;
  },

  getBackendPort: () => {
    return ipcRenderer.sendSync('get-backend-port-sync') as number;
  },

  getBackendStartupMode: () => {
    return ipcRenderer.sendSync('get-backend-startup-mode-sync') as 'managed' | 'external';
  },

  getBackendRepoPath: () => {
    return ipcRenderer.sendSync('get-backend-repo-path-sync') as string;
  },

  getOcrGpuMode: () => {
    return ipcRenderer.sendSync('get-ocr-gpu-mode-sync') as 'auto' | 'cpu' | 'cuda';
  },

  getSaveBackendScreenshots: () => {
    return ipcRenderer.sendSync('get-save-backend-screenshots-sync') as boolean;
  },

  setBackendPort: (port: number) => {
    return ipcRenderer.invoke('set-backend-port', port);
  },

  setBackendStartupMode: (mode: 'managed' | 'external') => {
    return ipcRenderer.invoke('set-backend-startup-mode', mode);
  },

  setBackendRepoPath: (repoPath: string | null) => {
    return ipcRenderer.invoke('set-backend-repo-path', repoPath);
  },

  setOcrGpuMode: (mode: 'auto' | 'cpu' | 'cuda') => {
    return ipcRenderer.invoke('set-ocr-gpu-mode', mode);
  },

  setSaveBackendScreenshots: (enabled: boolean) => {
    return ipcRenderer.invoke('set-save-backend-screenshots', enabled);
  },

  getUpdateMode: () => {
    return ipcRenderer.sendSync('get-update-mode-sync') as 'auto' | 'manual';
  },

  setUpdateMode: (mode: 'auto' | 'manual') => {
    return ipcRenderer.invoke('set-update-mode', mode);
  },

  openDirectoryDialog: (title?: string) => {
    return ipcRenderer.invoke('open-directory-dialog', title);
  },

  openFileDialog: (filters: { name: string; extensions: string[] }[], defaultDir?: string) => {
    return ipcRenderer.invoke('open-file-dialog', filters, defaultDir);
  },

  saveFile: (filePath: string, content: string) => {
    return ipcRenderer.invoke('save-file', filePath, content);
  },

  saveFileDialog: (defaultName: string, content: string, filters: { name: string; extensions: string[] }[]) => {
    return ipcRenderer.invoke('save-file-dialog', defaultName, content, filters);
  },

  readFile: (filePath: string) => {
    return ipcRenderer.invoke('read-file', filePath);
  },

  appendFile: (filePath: string, content: string) => {
    return ipcRenderer.invoke('append-file', filePath, content);
  },

  detectEmulator: () => {
    return ipcRenderer.invoke('detect-emulator');
  },

  checkAdbDevices: () => {
    return ipcRenderer.invoke('check-adb-devices');
  },

  getAppRoot: () => {
    return ipcRenderer.invoke('get-app-root');
  },

  resolveAppPath: (filePath: string) => {
    return ipcRenderer.invoke('resolve-app-path', filePath);
  },

  getPlansDir: () => {
    return ipcRenderer.invoke('get-plans-dir');
  },

  listPlanFiles: () => {
    return ipcRenderer.invoke('list-plan-files');
  },

  getConfigDir: () => {
    return ipcRenderer.invoke('get-config-dir');
  },

  openFolder: (folderPath: string) => {
    return ipcRenderer.invoke('open-folder', folderPath);
  },

  checkEnvironment: () => {
    return ipcRenderer.invoke('check-environment');
  },

  /*
   * 测试期接口（后端源码更新）已停用，逻辑保留便于回滚恢复。
  checkUpdates: () => {
    return ipcRenderer.invoke('check-updates');
  },
  */

  installDeps: () => {
    return ipcRenderer.invoke('install-deps');
  },

  /*
   * 测试期接口（后端源码更新）已停用，逻辑保留便于回滚恢复。
  pullUpdates: () => {
    return ipcRenderer.invoke('pull-updates');
  },
  */

  startBackend: () => {
    return ipcRenderer.invoke('start-backend');
  },

  runSetup: () => {
    return ipcRenderer.invoke('run-setup');
  },

  installPortablePython: () => {
    return ipcRenderer.invoke('install-portable-python');
  },

  // ── Python 路径配置 ──
  getPythonPath: () => {
    return ipcRenderer.sendSync('get-python-path-sync') as string | null;
  },

  setPythonPath: (pythonPath: string | null) => {
    return ipcRenderer.invoke('set-python-path', pythonPath);
  },

  validatePython: (pythonPath: string) => {
    return ipcRenderer.invoke('validate-python', pythonPath);
  },

  // ── GUI 自动更新 ──
  checkGuiUpdates: () => {
    return ipcRenderer.invoke('check-gui-updates');
  },

  downloadGuiUpdate: () => {
    return ipcRenderer.invoke('download-gui-update');
  },

  installGuiUpdate: () => {
    return ipcRenderer.invoke('install-gui-update');
  },

  onUpdateStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('update-status', (_event, status) => callback(status));
  },

  onBackendLog: (callback: (line: string) => void) => {
    ipcRenderer.on('backend-log', (_event, line: string) => callback(line));
  },

  onSetupLog: (callback: (text: string) => void) => {
    ipcRenderer.on('setup-log', (_event, text: string) => callback(text));
  },
});
