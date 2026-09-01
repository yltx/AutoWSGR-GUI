/** 协调迁移冲突弹窗与主进程安全文件操作。 */
import {
  MigrationConflictView,
} from '../../view/migration/MigrationConflictView.js';
import { showAlert, showConfirm } from '../../view/shared/DialogHelper.js';
import {
  getMigrationConflictRepository,
  type MigrationConflictRepository,
} from '../../adapter/IpcAdapter.js';

/** 启动时强制用户处理尚未确认的迁移 YAML 冲突。 */
export class MigrationConflictController {
  private finishReview: (() => void) | null = null;

  constructor(
    private readonly repository: MigrationConflictRepository | undefined =
      getMigrationConflictRepository(),
  ) {}

  private readonly view = new MigrationConflictView({
    onSubmit: keepIds => {
      void this.submit(keepIds);
    },
  });

  async reviewPending(): Promise<void> {
    if (!this.repository?.getMigrationConflicts) return;
    const result = await this.repository.getMigrationConflicts();
    if (result.pending && result.conflicts.length > 0) {
      this.view.open(result.conflicts);
      await new Promise<void>(resolve => {
        this.finishReview = resolve;
      });
    }
  }

  private async submit(keepIds: string[]): Promise<void> {
    if (!this.repository?.resolveMigrationConflicts) {
      this.view.setStatus('当前环境不支持处理迁移冲突，请重启 GUI。');
      return;
    }
    const deleteCount = this.view.deleteCount();
    if (deleteCount > 0) {
      const confirmed = await showConfirm(
        '确认删除未保留的 YAML',
        [
          `将直接删除 ${deleteCount} 个用户配置文件，此操作无法撤销。`,
          '与系统预设完全相同的任务列表和自动胖次引用会自动切换到系统预设。',
          '其他被删除配置的现有引用可能失效，存在数据丢失风险。',
        ].join('\n'),
      );
      if (!confirmed) return;
    }

    this.view.setBusy(true);
    this.view.setStatus('');
    try {
      const result = await this.repository.resolveMigrationConflicts(
        keepIds,
      );
      if (result.remaining.length > 0) {
        this.view.replace(result.remaining);
        this.view.setStatus(result.errors.join('\n'));
        return;
      }
      this.view.close();
      this.finishReview?.();
      this.finishReview = null;
      await showAlert(
        '迁移冲突处理完成',
        `保留 ${result.kept} 项，删除 ${result.deleted} 项。`,
      );
    } catch (error) {
      this.view.setBusy(false);
      this.view.setStatus(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
