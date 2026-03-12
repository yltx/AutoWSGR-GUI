/**
 * Preload 脚本 —— 通过 contextBridge 安全暴露 IPC 方法给渲染进程。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronBridge', {
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

  getPlansDir: () => {
    return ipcRenderer.invoke('get-plans-dir');
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

  checkUpdates: () => {
    return ipcRenderer.invoke('check-updates');
  },

  installDeps: () => {
    return ipcRenderer.invoke('install-deps');
  },

  pullUpdates: () => {
    return ipcRenderer.invoke('pull-updates');
  },

  startBackend: () => {
    return ipcRenderer.invoke('start-backend');
  },

  runSetup: () => {
    return ipcRenderer.invoke('run-setup');
  },

  installPortablePython: () => {
    return ipcRenderer.invoke('install-portable-python');
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
