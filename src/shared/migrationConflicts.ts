/** 迁移后需要用户确认的 YAML 冲突类型。 */
export type MigrationConflictKind = 'battle' | 'daily';

/** 一条可展示、可扩展的冲突原因。 */
export interface MigrationConflictReason {
  reasonCode: string;
  reason: string;
  relatedFile?: string;
}

/** Renderer 只接收受管文件身份，不接收本地绝对路径。 */
export interface MigrationConflictItem {
  id: string;
  kind: MigrationConflictKind;
  file: string;
  name: string;
  reasons: MigrationConflictReason[];
}

/** 启动时读取的待确认冲突。 */
export interface MigrationConflictListResult {
  pending: boolean;
  conflicts: MigrationConflictItem[];
}

/** 用户提交保留清单后的处理结果。 */
export interface MigrationConflictResolutionResult {
  success: boolean;
  kept: number;
  deleted: number;
  errors: string[];
  remaining: MigrationConflictItem[];
}
