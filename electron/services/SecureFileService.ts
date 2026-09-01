/**
 * 在路径能力边界内读写主进程文本文件。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFileStore } from './AtomicFileStore';
import { SafePathService } from './SafePathService';

export interface TextFileSnapshot {
  exists: boolean;
  content: string;
}

/** 集中管理主进程对普通文本文件的现有访问规则。 */
export class SecureFileService {
  constructor(
    private readonly safePaths: SafePathService,
    private readonly atomicFiles: AtomicFileStore,
  ) {}

  /** 在允许目录内覆盖保存 UTF-8 文本。 */
  save(filePath: string, content: string): void {
    let resolved = this.safePaths.resolveWritablePath(filePath);
    const directory = path.dirname(resolved);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    resolved = this.safePaths.resolveWritablePath(resolved);
    this.atomicFiles.write(resolved, content);
  }

  /** 在允许目录内读取 UTF-8 文本，不存在时返回空字符串。 */
  read(filePath: string): string {
    const resolved = this.safePaths.resolveReadablePath(filePath);
    if (!fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf-8');
  }

  /** 捕获受管文本文件，供跨文件提交失败时精确恢复。 */
  snapshot(filePath: string): TextFileSnapshot {
    const resolved = this.safePaths.resolveWritablePath(filePath);
    if (!fs.existsSync(resolved)) {
      return { exists: false, content: '' };
    }
    return {
      exists: true,
      content: fs.readFileSync(resolved, 'utf-8'),
    };
  }

  /** 恢复文本文件到提交前状态。 */
  restore(filePath: string, snapshot: TextFileSnapshot): void {
    if (snapshot.exists) {
      this.save(filePath, snapshot.content);
      return;
    }
    const resolved = this.safePaths.resolveWritablePath(filePath);
    fs.rmSync(resolved, { force: true });
  }

  /** 在允许目录内追加 UTF-8 文本。 */
  append(filePath: string, content: string): void {
    let resolved = this.safePaths.resolveWritablePath(filePath);
    const directory = path.dirname(resolved);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    resolved = this.safePaths.resolveWritablePath(resolved);
    fs.appendFileSync(resolved, content, 'utf-8');
  }

  /** 读取用户通过系统文件对话框显式选择的文件。 */
  readSelectedFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  /** 写入用户通过系统保存对话框显式选择的文件。 */
  writeSelectedFile(filePath: string, content: string): void {
    this.atomicFiles.write(filePath, content);
  }
}
