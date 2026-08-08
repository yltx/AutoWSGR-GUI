/**
 * 互斥运行舰船资料库更新并解析进度。
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ShipLibraryService } from './ShipLibraryService';
import type {
  ShipNameComparisonResult,
  ShipNameSyncResult,
} from './ShipNameSynchronizer';

export interface ShipLibraryUpdateResult {
  success: boolean;
  output?: string;
  generated_at?: string;
  ship_count?: number;
  asset_count?: number;
  added?: number;
  updated?: number;
  removed?: number;
  downloaded?: number;
  failed?: number;
  failures?: string[];
  shipnames_sync_error?: string;
  error?: string;
}

export interface ShipLibraryUpdaterDependencies {
  findPython(): Promise<string | null>;
  appRoot(): string;
  sendProgress(message: string): void;
  compareShipNames(pythonCmd: string): ShipNameComparisonResult;
  syncShipNames(pythonCmd: string): ShipNameSyncResult;
  spawnProcess?: typeof spawn;
}

/** 启动更新脚本、解析进度并保护单实例更新状态。 */
export class ShipLibraryUpdater {
  private running = false;

  constructor(
    private readonly library: ShipLibraryService,
    private readonly dependencies: ShipLibraryUpdaterDependencies,
  ) {}

  /** 执行一次互斥的舰船资料库更新。 */
  async update(): Promise<ShipLibraryUpdateResult> {
    if (this.running) {
      return {
        success: false,
        error: '舰船资料库正在更新，请稍候',
      };
    }
    this.running = true;
    try {
      return await this.run();
    } finally {
      this.running = false;
    }
  }

  /** 只读核对 GUI 船库与当前后端舰名库。 */
  async getBackendSyncStatus(): Promise<ShipNameComparisonResult> {
    const pythonCmd = await this.dependencies.findPython();
    if (!pythonCmd) {
      throw new Error('找不到可用的 Python 3.12 或 3.13');
    }
    return this.dependencies.compareShipNames(pythonCmd);
  }

  /** 不访问 Wiki，只把当前 GUI 舰名增量同步到后端。 */
  async syncBackend(): Promise<ShipLibraryUpdateResult> {
    if (this.running) {
      return {
        success: false,
        error: '舰船资料库正在更新，请稍候',
      };
    }
    this.running = true;
    try {
      const pythonCmd = await this.dependencies.findPython();
      if (!pythonCmd) {
        return {
          success: false,
          error: '找不到可用的 Python 3.12 或 3.13',
        };
      }
      this.dependencies.sendProgress('正在同步后端舰名库…');
      const syncResult = this.dependencies.syncShipNames(pythonCmd);
      return {
        success: true,
        ship_count: syncResult.totalRecords,
      };
    } catch (error) {
      return {
        success: false,
        error: `后端舰名同步失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    } finally {
      this.running = false;
    }
  }

  /** 启动 Python 更新脚本并解析机器可读输出。 */
  private async run(): Promise<ShipLibraryUpdateResult> {
    const pythonCmd = await this.dependencies.findPython();
    if (!pythonCmd) {
      return {
        success: false,
        error: '找不到可用的 Python 3.12 或 3.13',
      };
    }
    const updaterPath = this.library.updaterPath();
    if (!fs.existsSync(updaterPath)) {
      return {
        success: false,
        error: `找不到舰船资料库更新程序: ${updaterPath}`,
      };
    }

    const updateResult = await new Promise<ShipLibraryUpdateResult>((resolve) => {
      const spawnProcess = this.dependencies.spawnProcess ?? spawn;
      // 便携版 Python 的 ._pth 隔离模式不会自动加入脚本目录。
      const bootstrap = [
        'import runpy, sys',
        `sys.path.insert(0, ${JSON.stringify(path.dirname(updaterPath))})`,
        'script = sys.argv[1]',
        'sys.argv = sys.argv[1:]',
        'runpy.run_path(script, run_name="__main__")',
      ].join('; ');
      const child = spawnProcess(
        pythonCmd,
        [
          '-c',
          bootstrap,
          updaterPath,
          '--output',
          this.library.directory(),
          '--workers',
          '8',
          '--force-assets',
        ],
        {
          cwd: this.dependencies.appRoot(),
          windowsHide: true,
        },
      );
      let stdoutBuffer = '';
      let stderr = '';
      let result: ShipLibraryUpdateResult | null = null;

      const handleLine = (rawLine: string): void => {
        const line = rawLine.trim();
        if (!line) return;
        if (line.startsWith('PROGRESS sources')) {
          this.dependencies.sendProgress('正在获取舰R百科数据…');
        } else {
          const records = line.match(
            /^PROGRESS records parsed=(\d+)$/,
          );
          const assets = line.match(
            /^PROGRESS assets (\d+)\/(\d+) downloaded=(\d+) failed=(\d+)$/,
          );
          if (records) {
            this.dependencies.sendProgress(
              `已读取 ${records[1]} 艘舰船，正在检查本地资源…`,
            );
          } else if (assets) {
            this.dependencies.sendProgress(
              `正在检查资源 ${assets[1]}/${assets[2]}，已下载 ${assets[3]}，失败 ${assets[4]}`,
            );
          }
        }
        if (line.startsWith('RESULT_JSON=')) {
          try {
            result = JSON.parse(
              line.slice('RESULT_JSON='.length),
            ) as ShipLibraryUpdateResult;
          } catch {
            result = {
              success: false,
              error: '更新程序返回了无效结果',
            };
          }
        }
      };

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        lines.forEach(handleLine);
      });
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        resolve({
          success: false,
          error: `更新程序启动失败: ${error.message}`,
        });
      });
      child.once('close', (code) => {
        if (stdoutBuffer) handleLine(stdoutBuffer);
        resolve(result ?? {
          success: false,
          error: stderr.trim()
            || `更新程序异常退出（代码 ${code ?? 'unknown'}）`,
        });
      });
    });
    if (!updateResult.success) return updateResult;

    this.dependencies.sendProgress('正在同步后端舰名库…');
    try {
      this.dependencies.syncShipNames(pythonCmd);
      return updateResult;
    } catch (error) {
      return {
        ...updateResult,
        shipnames_sync_error: error instanceof Error
          ? error.message
          : String(error),
      };
    }
  }
}
