import * as fs from 'fs';
import * as path from 'path';
import { AppPaths } from './AppPaths';

export interface GuiLogSettings {
  guiLogRoot(): string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateTag(): string {
  const date = new Date();
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function resolveGuiLogDirectory(
  configuredRoot: string,
  userDataRoot: string,
): string {
  const root = configuredRoot.trim() || 'logs';
  if (root.includes('\0')) throw new Error('GUI log directory contains an invalid character');
  if (root.split(/[\\/]+/).includes('..')) {
    throw new Error('GUI log directory must not contain ..');
  }

  const hasDrivePrefix = /^[a-zA-Z]:/.test(root);
  const windowsAbsolute = path.win32.isAbsolute(root);
  if (hasDrivePrefix && !windowsAbsolute) {
    throw new Error('GUI log directory must not use a drive-relative path');
  }
  if (path.isAbsolute(root) || windowsAbsolute) return root;
  return path.resolve(userDataRoot, root);
}

/** Writes renderer logs to the configured root without accepting a renderer path. */
export class GuiLogService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly settings: GuiLogSettings,
  ) {}

  append(content: string): void {
    if (typeof content !== 'string') throw new Error('GUI log content must be a string');

    const directory = resolveGuiLogDirectory(
      this.settings.guiLogRoot(),
      this.appPaths.userDataRoot(),
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(
      path.join(directory, `gui_${dateTag()}.debug.log`),
      content,
      'utf-8',
    );
  }
}
