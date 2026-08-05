/**
 * 集中提供应用、资源和用户数据目录。
 */
import * as path from 'path';

/** Electron 路径能力的最小依赖，便于主进程注入和独立测试。 */
export interface AppPathsDependencies {
  readonly moduleDirectory: string;
  isPackaged(): boolean;
  getPath(name: 'exe' | 'userData'): string;
  getResourcesPath(): string;
}

/** 集中计算主进程使用的应用、资源和用户数据路径。 */
export class AppPaths {
  constructor(private readonly dependencies: AppPathsDependencies) {}

  /** 是否处于打包后的生产模式。 */
  isPackaged(): boolean {
    return this.dependencies.isPackaged();
  }

  /** 返回开发项目根目录或打包后的可执行文件目录。 */
  appRoot(): string {
    if (this.isPackaged()) {
      return path.dirname(this.dependencies.getPath('exe'));
    }
    return path.join(this.dependencies.moduleDirectory, '..', '..');
  }

  /** extraResources 根目录。 */
  resourceRoot(): string {
    if (this.isPackaged()) {
      return this.dependencies.getResourcesPath();
    }
    return path.join(this.dependencies.moduleDirectory, '..', '..');
  }

  /** Electron 管理的用户数据根目录。 */
  userDataRoot(): string {
    return this.dependencies.getPath('userData');
  }

  /** 内置只读作战计划目录。 */
  systemBattlePlansDir(): string {
    return path.join(
      this.resourceRoot(),
      'resource',
      'system_battle_plans',
    );
  }

  /** GUI 管理的用户作战计划目录。 */
  userBattlePlansDir(): string {
    return path.join(this.userDataRoot(), 'user_battle_plans');
  }

  /** 内置只读日常任务计划目录。 */
  systemDailyPlansDir(): string {
    return path.join(
      this.resourceRoot(),
      'resource',
      'system_daily_plans',
    );
  }

  /** GUI 管理的用户日常任务计划目录。 */
  userDailyPlansDir(): string {
    return path.join(this.userDataRoot(), 'user_daily_plans');
  }

  /** 内置只读编队计划目录。 */
  systemTeamPlansDir(): string {
    return path.join(
      this.resourceRoot(),
      'resource',
      'system_team_plans',
    );
  }

  /** GUI 管理的用户编队计划目录。 */
  userTeamPlansDir(): string {
    return path.join(this.userDataRoot(), 'user_team_plans');
  }
}
