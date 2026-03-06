/**
 * Preload 脚本 —— 通过 contextBridge 安全暴露 IPC 方法给渲染进程。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronBridge', {
  openFileDialog: (filters: { name: string; extensions: string[] }[]) => {
    return ipcRenderer.invoke('open-file-dialog', filters);
  },

  saveFile: (filePath: string, content: string) => {
    return ipcRenderer.invoke('save-file', filePath, content);
  },

  readFile: (filePath: string) => {
    return ipcRenderer.invoke('read-file', filePath);
  },

  detectEmulator: () => {
    return ipcRenderer.invoke('detect-emulator');
  },

  getAppRoot: () => {
    return ipcRenderer.invoke('get-app-root');
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

  onBackendLog: (callback: (line: string) => void) => {
    ipcRenderer.on('backend-log', (_event, line: string) => callback(line));
  },

  onSetupLog: (callback: (text: string) => void) => {
    ipcRenderer.on('setup-log', (_event, text: string) => callback(text));
  },
});
