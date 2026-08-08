/**
 * 管理 ADB 设备发现、连接和断开。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppPaths } from './AppPaths';

const execFileAsync = promisify(execFile);

export interface AdbDevice {
  serial: string;
  status: string;
}

export interface AdbCommandResult {
  stdout: unknown;
  stderr: unknown;
}

export interface AdbCommandOptions {
  windowsHide: true;
  timeout: number;
  encoding: 'utf8';
}

export interface AdbServiceDependencies {
  execute(
    executable: string,
    args: string[],
    options: AdbCommandOptions,
  ): Promise<AdbCommandResult>;
}

export interface AdbDeviceCommandResult {
  success: boolean;
  serial: string;
  status: string;
  message: string;
}

/** 执行 ADB 设备查询和连接状态确认。 */
export class AdbService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly dependencies: AdbServiceDependencies = {
      execute: async (executable, args, options) => {
        const result = await execFileAsync(executable, args, options);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    },
  ) {}

  /** 返回内置 ADB；不存在时继续使用系统命令。 */
  executable(): string {
    const bundledAdb = path.join(
      this.appPaths.appRoot(),
      'adb',
      'adb.exe',
    );
    return fs.existsSync(bundledAdb) ? bundledAdb : 'adb';
  }

  /** 停止 ADB server，避免 GUI 退出后 adb.exe 继续占用安装目录。 */
  async stopServer(): Promise<void> {
    await this.dependencies.execute(
      this.executable(),
      ['kill-server'],
      {
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8',
      },
    );
  }

  /** 读取并解析 adb devices 的当前设备列表。 */
  async listDevices(): Promise<AdbDevice[]> {
    const { stdout } = await this.dependencies.execute(
      this.executable(),
      ['devices'],
      {
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8',
      },
    );
    return String(stdout)
      .split(/\r?\n/)
      .slice(1)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [serial, status] = line.split(/\s+/);
        return {
          serial,
          status: status || 'unknown',
        };
      });
  }

  /** 执行 connect 或 disconnect，并通过设备列表确认结果。 */
  async runDeviceCommand(
    command: 'connect' | 'disconnect',
    rawSerial: string,
  ): Promise<AdbDeviceCommandResult> {
    const serial = String(rawSerial ?? '').trim();
    if (!serial || !/^[A-Za-z0-9._:[\]-]+$/.test(serial)) {
      return {
        success: false,
        serial,
        status: 'invalid',
        message: 'ADB 地址格式不正确',
      };
    }

    try {
      const { stdout, stderr } = await this.dependencies.execute(
        this.executable(),
        [command, serial],
        {
          windowsHide: true,
          timeout: 10000,
          encoding: 'utf8',
        },
      );
      const devices = await this.listDevices();
      const status = devices.find(
        device => device.serial === serial,
      )?.status;
      const success = command === 'connect'
        ? status === 'device'
        : status === undefined;
      return {
        success,
        serial,
        status: status ?? 'disconnected',
        message: [stdout, stderr]
          .map(value => String(value).trim())
          .filter(Boolean)
          .join('\n')
          || (
            success
              ? '操作成功'
              : '操作后设备状态未达到预期'
          ),
      };
    } catch (error) {
      const details = error as {
        message?: string;
        stdout?: string;
        stderr?: string;
      };
      return {
        success: false,
        serial,
        status: 'error',
        message: [
          details.stderr,
          details.stdout,
          details.message,
        ]
          .map(value => String(value ?? '').trim())
          .find(Boolean)
          || 'ADB 命令执行失败',
      };
    }
  }
}
