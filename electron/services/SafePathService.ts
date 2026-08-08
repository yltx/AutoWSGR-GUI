/**
 * 解析应用路径并阻止越界、穿越和链接逃逸。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppPaths } from './AppPaths';

type FileCapability = 'read' | 'write';

/** 统一执行主进程文件能力的目录边界检查。 */
export class SafePathService {
  constructor(private readonly appPaths: AppPaths) {}

  /** 为兼容现有调用方解析一个可读取的应用路径。 */
  resolveAppPath(filePath: string): string {
    return this.resolve(filePath, 'read');
  }

  /** 解析只允许读取的 userData 或打包资源路径。 */
  resolveReadablePath(filePath: string): string {
    return this.resolve(filePath, 'read');
  }

  /** 解析只允许写入的 userData 路径。 */
  resolveWritablePath(filePath: string): string {
    return this.resolve(filePath, 'write');
  }

  private resolve(filePath: string, capability: FileCapability): string {
    const raw = typeof filePath === 'string' ? filePath.trim() : '';
    if (!raw) throw new Error('文件路径不能为空');
    if (raw.includes('\0')) throw new Error('文件路径包含非法字符');
    if (/^[\\/]{2}/.test(raw)) throw new Error('不允许使用 UNC 路径');

    const hasDrivePrefix = /^[a-zA-Z]:/.test(raw);
    const windowsAbsolute = path.win32.isAbsolute(raw);
    const nativeAbsolute = path.isAbsolute(raw);
    const portableAbsolute = windowsAbsolute || path.posix.isAbsolute(raw);
    if (hasDrivePrefix && !windowsAbsolute) {
      throw new Error('不允许使用盘符相对路径');
    }
    if (portableAbsolute && !nativeAbsolute) {
      throw new Error('不允许切换路径根目录');
    }
    const pathWithoutDrive = hasDrivePrefix ? raw.slice(2) : raw;
    if (pathWithoutDrive.includes(':')) {
      throw new Error('文件路径包含非法字符');
    }

    const segments = raw.split(/[\\/]+/);
    if (segments.includes('..')) {
      throw new Error('文件路径不允许包含 ..');
    }

    const resourceDirectory = path.join(
      this.appPaths.resourceRoot(),
      'resource',
    );
    const isResourceRelative = !nativeAbsolute
      && segments[0]?.toLowerCase() === 'resource';
    if (capability === 'write' && isResourceRelative) {
      throw new Error('安装资源目录为只读');
    }

    const relativeSegments = isResourceRelative
      ? segments.slice(1)
      : segments;
    const relativeRoot = isResourceRelative
      ? resourceDirectory
      : this.appPaths.userDataRoot();
    const candidate = nativeAbsolute
      ? path.resolve(raw)
      : path.resolve(relativeRoot, ...relativeSegments);
    const roots = capability === 'read'
      ? [this.appPaths.userDataRoot(), resourceDirectory]
      : [this.appPaths.userDataRoot()];
    const allowed = roots.some(root => this.isContained(candidate, root));
    if (!allowed) throw new Error('文件路径超出应用允许目录');
    return candidate;
  }

  /** 先验证词法边界，再拒绝允许根目录内的任何链接节点。 */
  private isContained(candidate: string, root: string): boolean {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedRoot = path.resolve(root);
    const normalizedCandidate = this.normalizeForComparison(
      resolvedCandidate,
    );
    const normalizedRoot = this.normalizeForComparison(resolvedRoot);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    const contained = relative === ''
      || (
        relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
      );
    if (!contained) return false;
    this.assertNoLinks(resolvedCandidate, resolvedRoot);
    return true;
  }

  /** lstat 不跟随链接，因此目录联接和悬空链接也会被拒绝。 */
  private assertNoLinks(candidate: string, root: string): void {
    const relative = path.relative(root, candidate);
    const segments = relative ? relative.split(path.sep) : [];
    let current = root;
    for (const segment of ['', ...segments]) {
      if (segment) current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error('文件路径不允许包含符号链接或联接点');
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return;
        throw error;
      }
    }
  }

  /** Windows 文件系统路径按不区分大小写规则比较。 */
  private normalizeForComparison(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}
