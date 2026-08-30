/** 编排远征收取、奖励领取等常用自动化操作。 */
import type { ApiResponse } from '../../types/api.js';
import { ApiClient } from '../../model/ApiClient';
import { MainView } from '../../view/main/MainView';
import type { OperationName } from '../../view/main/StatusBar';
import { Logger } from '../../utils/Logger';

export class OperationsController {
  private readonly operations: Record<
    OperationName,
    { label: string; run: () => Promise<ApiResponse> }
  >;

  constructor(
    private readonly api: ApiClient,
    private readonly mainView: MainView,
    private readonly logger: typeof Logger,
  ) {
    this.operations = {
      expedition: {
        label: '收取远征',
        run: () => this.api.expeditionCheck(),
      },
      reward: {
        label: '收取奖励',
        run: () => this.api.rewardCollect(),
      },
      buildCollect: {
        label: '收取建造',
        run: () => this.api.buildCollect(),
      },
      cook: {
        label: '食堂烹饪',
        run: () => this.api.cook(),
      },
      repair: {
        label: '浴室修理',
        run: () => this.api.repairBath(),
      },
      intensify: {
        label: '自动强化',
        run: () => this.api.autoIntensify(),
      },
    };
  }

  bindOpsActions(): void {
    this.mainView.onOperation = operation => {
      void this.runOperation(operation);
    };
  }

  updateOpsAvailability(connected: boolean): void {
    this.mainView.setOpsAvailability(connected);
  }

  private async runOperation(operation: OperationName): Promise<void> {
    const { label, run } = this.operations[operation];
    this.mainView.setOperationLoading(operation, true);
    this.mainView.setOpsStatus(`${label}中…`);
    try {
      const response = await run();
      if (response.success) {
        this.logger.info(`${label}完成`);
        this.mainView.setOpsStatus(`${label}完成`);
      } else {
        this.logger.warn(
          `${label}失败: ${response.message ?? '未知错误'}`,
        );
        this.mainView.setOpsStatus(`${label}失败`);
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);
      this.logger.error(`${label}异常: ${message}`);
      this.mainView.setOpsStatus(`${label}异常`);
    } finally {
      this.mainView.setOperationLoading(operation, false);
      setTimeout(() => this.mainView.setOpsStatus(''), 3000);
    }
  }
}
