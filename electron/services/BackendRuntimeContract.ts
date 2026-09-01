/**
 * 定义 GUI 与 AutoWSGR 后端之间的正式运行契约。
 *
 * GUI 只通过环境变量控制 OCR 加速和截图保存，不修改后端类、
 * 函数或日志模块的私有成员。启动前会检查当前后端是否支持这些
 * 环境变量，并确认实际导入的源码来自当前环境声明的唯一来源。
 */
import type { PythonEnvironment } from '../pythonEnv';
import {
  buildBackendRuntimeContractProbeLines,
} from '../pythonEnv/backendContractProbe';

export type BackendOcrGpuMode = 'auto' | 'cpu' | 'cuda';
export type ResolvedBackendOcrGpuMode = Exclude<
  BackendOcrGpuMode,
  'auto'
>;

export interface BackendRuntimeSettings {
  ocrGpuMode: ResolvedBackendOcrGpuMode;
  wsgNccGpu: boolean;
  saveImages: boolean;
}

export const BACKEND_RUNTIME_CONTRACT = 'gui-runtime-env-v1';

/** 将 GUI 模式与 CUDA 探测结果转换为后端支持的明确模式。 */
export function selectBackendOcrGpuMode(
  requestedMode: BackendOcrGpuMode,
  cudaAvailable: boolean,
): ResolvedBackendOcrGpuMode {
  if (requestedMode === 'cpu') return 'cpu';
  if (cudaAvailable) return 'cuda';
  if (requestedMode === 'auto') return 'cpu';
  throw new Error('已强制使用 CUDA，但未检测到可用 CUDA');
}

/** WSG-NCC 使用 WebGPU；非 CPU 模式均尝试 GPU，并由运行时安全回退。 */
export function selectBackendWsgNccGpu(
  requestedMode: BackendOcrGpuMode,
): boolean {
  return requestedMode !== 'cpu';
}

function pythonLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function pythonPathSetup(environment: PythonEnvironment): string[] {
  return [
    'import sys, os, site',
    ...(environment.useLocalSite
      ? [
          `sp = r'${pythonLiteral(environment.localSite)}'`,
          'sys.path.insert(0, sp)',
          'site.addsitedir(sp)',
        ]
      : []),
    ...(environment.backendRoot
      ? [
          `repo = r'${pythonLiteral(environment.backendRoot)}'`,
          'sys.path.insert(0, repo)',
        ]
      : []),
  ];
}

function sourceVerification(environment: PythonEnvironment): string[] {
  const expectedRoot = environment.backendRoot
    ?? environment.localSite;
  return [
    'from pathlib import Path',
    'import autowsgr',
    `_expected_root = Path(r'${pythonLiteral(expectedRoot)}').resolve()`,
    '_autowsgr_file = Path(autowsgr.__file__).resolve()',
    'if not _autowsgr_file.is_relative_to(_expected_root):',
    "    raise RuntimeError('GUI 后端来源错误: ' + str(_autowsgr_file))",
  ];
}

/** 将 GUI 运行设置写入后端已经公开支持的环境变量。 */
export function applyBackendRuntimeSettings(
  baseEnv: NodeJS.ProcessEnv,
  settings: BackendRuntimeSettings,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    AUTOWSGR_OCR_GPU_MODE: settings.ocrGpuMode,
    AUTOWSGR_WSG_NCC_GPU: settings.wsgNccGpu ? 'true' : 'false',
    AUTOWSGR_SAVE_IMAGES: settings.saveImages ? 'true' : 'false',
  };
}

/** 生成启动前能力探测脚本；不满足契约时由 Python 明确报错。 */
export function buildBackendCapabilityProbe(
  environment: PythonEnvironment,
): string {
  return [
    ...pythonPathSetup(environment),
    ...sourceVerification(environment),
    ...buildBackendRuntimeContractProbeLines(),
    '_verify_gui_runtime_contract()',
    'from autowsgr.server.main import app as _backend_app',
    'import inspect as _inspect',
    'if not callable(_backend_app):',
    "    raise RuntimeError('AutoWSGR server app 不可调用')",
    '_app_call = getattr(_backend_app, "__call__", None)',
    'if not (_inspect.iscoroutinefunction(_backend_app) or _inspect.iscoroutinefunction(_app_call)):',
    "    raise RuntimeError('AutoWSGR server app 不是 ASGI 应用')",
    `print('[Contract] ${BACKEND_RUNTIME_CONTRACT}')`,
    "print('[Contract] autowsgr=' + str(_autowsgr_file))",
  ].join('\n');
}

/** 生成通过能力检查后使用的最小后端启动脚本。 */
export function buildBackendBootstrap(
  environment: PythonEnvironment,
  port: number,
): string {
  return [
    ...pythonPathSetup(environment),
    ...sourceVerification(environment),
    "print('[Bootstrap] autowsgr=' + str(_autowsgr_file))",
    "print('[Bootstrap] ocr_gpu_mode=' + os.environ.get('AUTOWSGR_OCR_GPU_MODE', 'cpu'))",
    "print('[Bootstrap] wsg_ncc_gpu=' + os.environ.get('AUTOWSGR_WSG_NCC_GPU', 'false'))",
    "print('[Bootstrap] save_backend_screenshots=' + os.environ.get('AUTOWSGR_SAVE_IMAGES', 'false'))",
    'import uvicorn',
    `uvicorn.run('autowsgr.server.main:app', host='127.0.0.1', port=${port})`,
  ].join('\n');
}
