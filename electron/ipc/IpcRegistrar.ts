/**
 * 定义 IPC Adapter 使用的最小注册接口。
 */
import type { IpcMain } from 'electron';

export type IpcRegistrar = Pick<IpcMain, 'handle' | 'on'>;
