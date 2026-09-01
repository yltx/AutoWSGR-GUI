/**
 * 校验 Python 并编排环境检查和依赖安装。
 */
import { exec } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import type { EnvCheckResult } from '../pythonEnv';

const execAsync = promisify(exec);

export interface PythonValidationResult {
  valid: boolean;
  version: string | null;
  error?: string;
}

export interface PythonEnvironmentDependencies {
  fileExists(filePath: string): boolean;
  readVersion(pythonPath: string): Promise<string>;
  isAllowedVersion(version: string): boolean;
  findPython(): Promise<string | null>;
  checkEnvironment(): Promise<EnvCheckResult>;
  installDependencies(
    pythonPath: string,
  ): Promise<{ success: boolean; output: string }>;
  installPortablePython(): Promise<{ success: boolean }>;
}

/** 统一 Python 校验、环境检查和安装入口。 */
export class PythonEnvironmentService {
  constructor(
    private readonly dependencies: PythonEnvironmentDependencies,
  ) {}

  /** 构造保持原文件检查、命令格式和超时的系统依赖。 */
  static createDependencies(
    dependencies: Omit<
      PythonEnvironmentDependencies,
      'fileExists' | 'readVersion'
    >,
  ): PythonEnvironmentDependencies {
    return {
      ...dependencies,
      fileExists: filePath => fs.existsSync(filePath),
      readVersion: async pythonPath => {
        const { stdout } = await execAsync(
          `"${pythonPath}" --version`,
          {
            windowsHide: true,
            timeout: 10000,
          },
        );
        return stdout.trim();
      },
    };
  }

  /** 校验指定解释器是否存在且版本兼容。 */
  async validate(
    pythonPath: string,
  ): Promise<PythonValidationResult> {
    if (!pythonPath) {
      return {
        valid: false,
        version: null,
        error: '路径为空',
      };
    }
    if (!this.dependencies.fileExists(pythonPath)) {
      return {
        valid: false,
        version: null,
        error: '文件不存在',
      };
    }
    try {
      const version = await this.dependencies.readVersion(pythonPath);
      if (!this.dependencies.isAllowedVersion(version)) {
        return {
          valid: false,
          version,
          error: `版本不兼容: ${version}（需要 3.12 或 3.13）`,
        };
      }
      return { valid: true, version };
    } catch (error) {
      return {
        valid: false,
        version: null,
        error: `执行失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** 执行现有 Python 环境检查流程。 */
  check(): Promise<EnvCheckResult> {
    return this.dependencies.checkEnvironment();
  }

  /** 查找 Python 后安装后端依赖。 */
  async installDependencies(): Promise<{
    success: boolean;
    output: string;
  }> {
    const pythonPath = await this.dependencies.findPython();
    if (!pythonPath) {
      return { success: false, output: '找不到 Python' };
    }
    return this.dependencies.installDependencies(pythonPath);
  }

  /** 安装或初始化现有便携 Python。 */
  installPortablePython(): Promise<{ success: boolean }> {
    return this.dependencies.installPortablePython();
  }
}
