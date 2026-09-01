/**
 * 校验 CUDA 路径并检测 PyTorch 的 CUDA 能力。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  buildBackendRuntimeEnvironment,
  readCudaVersionFile,
  resolvePythonEnvironment,
} from '../pythonEnv';

const execFileAsync = promisify(execFile);

export interface CudaValidationResult {
  valid: boolean;
  path: string;
  version: string | null;
  kind?: 'toolkit' | 'runtime';
  torchVersion?: string | null;
  device?: string | null;
  error?: string;
}

export interface CudaCommandOptions {
  windowsHide: true;
  timeout: 20000;
  encoding: 'utf8';
  env: NodeJS.ProcessEnv;
}

export interface CudaEnvironmentDependencies {
  findPython(): Promise<string | null>;
  buildRuntimeEnvironment(
    pythonCommand: string,
    configuredCudaRoot: string | null,
  ): NodeJS.ProcessEnv;
  execute(
    executable: string,
    args: string[],
    options: CudaCommandOptions,
  ): Promise<{ stdout: unknown }>;
}

interface CudaDetectionPayload {
  available: boolean;
  torchVersion: string | null;
  cudaVersion: string | null;
  device: string | null;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseCudaDetectionPayload(value: unknown): CudaDetectionPayload {
  if (!isRecord(value)) {
    throw new Error('Python 返回的检测结果不是对象');
  }
  return {
    available: value.available === true,
    torchVersion: optionalText(value.torch_version),
    cudaVersion: optionalText(value.cuda_version),
    device: optionalText(value.device),
    error: optionalText(value.error),
  };
}

/** 校验 CUDA 目录并检测当前 PyTorch 的实际 CUDA 能力。 */
export class CudaEnvironmentService {
  constructor(
    private readonly dependencies: CudaEnvironmentDependencies,
  ) {}

  /** 使用生产子进程执行器创建服务依赖。 */
  static createDependencies(
    findPython: () => Promise<string | null>,
  ): CudaEnvironmentDependencies {
    return {
      findPython,
      buildRuntimeEnvironment: (pythonCommand, configuredCudaRoot) => (
        buildBackendRuntimeEnvironment(
          resolvePythonEnvironment(pythonCommand),
          configuredCudaRoot,
        )
      ),
      execute: async (executable, args, options) => {
        const result = await execFileAsync(
          executable,
          args,
          options,
        );
        return { stdout: result.stdout };
      },
    };
  }

  /** 将配置输入归一化为 Toolkit 根目录或 Runtime 目录。 */
  normalizePath(candidate: string): string {
    const resolved = path.resolve(candidate.trim());
    if (this.findRuntimeDlls(resolved)) return resolved;
    return path.basename(resolved).toLowerCase() === 'bin'
      ? path.dirname(resolved)
      : resolved;
  }

  /** 只校验本地 CUDA 路径并读取可用版本信息。 */
  validatePath(candidate: string): CudaValidationResult {
    if (!candidate.trim()) {
      return {
        valid: false,
        path: '',
        version: null,
        error: '路径为空',
      };
    }
    const cudaRoot = this.normalizePath(candidate);
    if (!fs.existsSync(cudaRoot)) {
      return {
        valid: false,
        path: cudaRoot,
        version: null,
        error: '目录不存在',
      };
    }
    const binDirectory = path.join(cudaRoot, 'bin');
    const isToolkit = fs.existsSync(
      path.join(binDirectory, 'nvcc.exe'),
    );
    const runtimeDirectory = this.findRuntimeDlls(cudaRoot)
      ? cudaRoot
      : this.findRuntimeDlls(binDirectory)
        ? binDirectory
        : null;
    if (!isToolkit && !runtimeDirectory) {
      return {
        valid: false,
        path: cudaRoot,
        version: null,
        error: '未找到 CUDA Toolkit（bin\\nvcc.exe）或 PyTorch CUDA Runtime DLL',
      };
    }

    let version = readCudaVersionFile(cudaRoot);
    version ??= path.basename(cudaRoot)
      .match(/v\d+(?:\.\d+)?/i)?.[0]
      ?? null;
    if (isToolkit) {
      return {
        valid: true,
        path: cudaRoot,
        version,
        kind: 'toolkit',
      };
    }

    let runtimeVersion: string | null = null;
    try {
      const cudart = fs.readdirSync(runtimeDirectory!)
        .find(name => /^cudart64.*\.dll$/i.test(name));
      runtimeVersion = cudart
        ?.match(/^cudart64[_-]?(\d+)/i)?.[1]
        ?? null;
      if (runtimeVersion?.length === 2) {
        runtimeVersion = `${runtimeVersion[0]}.${runtimeVersion[1]}`;
      } else if (runtimeVersion?.length === 3) {
        runtimeVersion = `${
          runtimeVersion.slice(0, 2)
        }.${runtimeVersion[2]}`;
      }
    } catch {
      // 无法解析时保留未知版本。
    }
    return {
      valid: true,
      path: runtimeDirectory!,
      version: runtimeVersion,
      kind: 'runtime',
    };
  }

  /** 使用后端实际采用的 Python 检测 PyTorch、CUDA 和显卡。 */
  async detect(candidate: string): Promise<CudaValidationResult> {
    const rawPath = candidate.trim();
    const pathResult = rawPath
      ? this.validatePath(rawPath)
      : null;
    if (pathResult && !pathResult.valid) return pathResult;

    const pythonCommand = await this.dependencies.findPython();
    if (!pythonCommand) {
      return {
        valid: false,
        path: pathResult?.path ?? '',
        version: pathResult?.version ?? null,
        kind: pathResult?.kind,
        error: '未找到可用的 Python 3.12 或 3.13',
      };
    }

    const script = [
      'import json',
      'try:',
      '    import torch',
      '    available = bool(torch.cuda.is_available())',
      '    result = {',
      '        "available": available,',
      '        "torch_version": str(torch.__version__),',
      '        "cuda_version": getattr(torch.version, "cuda", None),',
      '        "device": torch.cuda.get_device_name(0) if available else None,',
      '    }',
      'except Exception as exc:',
      '    result = {"available": False, "error": str(exc)}',
      'print(json.dumps(result, ensure_ascii=False))',
    ].join('\n');

    try {
      const { stdout } = await this.dependencies.execute(
        pythonCommand,
        ['-c', script],
        {
          windowsHide: true,
          timeout: 20000,
          encoding: 'utf8',
          env: this.dependencies.buildRuntimeEnvironment(
            pythonCommand,
            pathResult?.path ?? null,
          ),
        },
      );
      const output = String(stdout)
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .at(-1);
      if (!output) throw new Error('Python 未返回检测结果');
      const parsed: unknown = JSON.parse(output);
      const detected = parseCudaDetectionPayload(parsed);
      const version = detected.cudaVersion
        ?? pathResult?.version
        ?? null;
      if (!detected.available) {
        return {
          valid: false,
          path: pathResult?.path ?? '',
          version,
          kind: pathResult?.kind,
          torchVersion: detected.torchVersion,
          device: null,
          error: detected.error
            ? `PyTorch 检测失败：${detected.error}`
            : `PyTorch ${
              detected.torchVersion ?? ''
            } 未检测到可用 CUDA`
              .replace(/\s+/g, ' ')
              .trim(),
        };
      }
      return {
        valid: true,
        path: pathResult?.path ?? '',
        version,
        kind: pathResult?.kind,
        torchVersion: detected.torchVersion,
        device: detected.device,
      };
    } catch (error) {
      return {
        valid: false,
        path: pathResult?.path ?? '',
        version: pathResult?.version ?? null,
        kind: pathResult?.kind,
        error: `硬件检测失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** 检查目录中是否同时包含必要 CUDA Runtime DLL。 */
  private findRuntimeDlls(directory: string): boolean {
    try {
      const names = fs.readdirSync(directory);
      return names.some(name => /^cudart64.*\.dll$/i.test(name))
        && names.some(name => /^cublas64.*\.dll$/i.test(name));
    } catch {
      return false;
    }
  }
}
