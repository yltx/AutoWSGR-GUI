import * as path from 'path';

export const SHIP_LIBRARY_ENV = 'AUTOWSGR_SHIP_LIBRARY';
export const STRENGTHEN_DATA_ENV = 'AUTOWSGR_STRENGTHEN_DATA';
export const WSG_NCC_DATA_ENV = 'AUTOWSGR_WSG_NCC_DATA';

/** Resolve the canonical read-only ship library bundled with the GUI. */
export function shipLibraryRoot(resourceRoot: string): string {
  return path.join(resourceRoot, 'resource', 'ship-library');
}

/** Resolve the canonical read-only strengthen data bundled with the GUI. */
export function strengthenDataPath(resourceRoot: string): string {
  return path.join(resourceRoot, 'resource', 'strengthen.json');
}

/** Resolve the WSG-NCC runtime data bundled with the GUI. */
export function wsgNccDataRoot(resourceRoot: string): string {
  return path.join(resourceRoot, 'resource', 'wsg-ncc');
}

/** Resolve the bundled WSG-NCC Python import root. */
export function wsgNccPythonRoot(resourceRoot: string): string {
  return path.join(wsgNccDataRoot(resourceRoot), 'python');
}

/** Add GUI-owned resource paths to a child process environment. */
export function buildResourceEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  resourceRoot: string,
): NodeJS.ProcessEnv {
  const pythonRoot = wsgNccPythonRoot(resourceRoot);
  const normalizedPythonRoot = path.resolve(pythonRoot);
  const existingPythonPaths = (baseEnv.PYTHONPATH || '')
    .split(path.delimiter)
    .filter((entry) => {
      if (!entry) return false;
      const normalizedEntry = path.resolve(entry);
      return process.platform === 'win32'
        ? normalizedEntry.toLowerCase() !== normalizedPythonRoot.toLowerCase()
        : normalizedEntry !== normalizedPythonRoot;
    });
  return {
    ...baseEnv,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: [pythonRoot, ...existingPythonPaths].join(path.delimiter),
    [SHIP_LIBRARY_ENV]: shipLibraryRoot(resourceRoot),
    [STRENGTHEN_DATA_ENV]: strengthenDataPath(resourceRoot),
    [WSG_NCC_DATA_ENV]: wsgNccDataRoot(resourceRoot),
  };
}

/** Make embedded Python honor and verify the GUI-owned runtime path. */
export function withResourcePythonBootstrap(script: string): string {
  return [
    'import os as _gui_os, sys as _gui_sys',
    `_gui_python_paths = [p for p in _gui_os.environ.get('PYTHONPATH', '').split(_gui_os.pathsep) if p]`,
    'for _gui_python_path in reversed(_gui_python_paths):',
    '    if _gui_python_path not in _gui_sys.path:',
    '        _gui_sys.path.insert(0, _gui_python_path)',
    'from pathlib import Path as _GuiResourcePath',
    'import cascade_ncc as _gui_cascade_ncc',
    `_gui_expected_cascade_root = (_GuiResourcePath(_gui_os.environ['${WSG_NCC_DATA_ENV}']) / 'python').resolve()`,
    '_gui_cascade_file = _GuiResourcePath(_gui_cascade_ncc.__file__).resolve()',
    'if not _gui_cascade_file.is_relative_to(_gui_expected_cascade_root):',
    `    raise RuntimeError('GUI WSG-NCC runtime source error: ' + str(_gui_cascade_file))`,
    script,
  ].join('\n');
}
