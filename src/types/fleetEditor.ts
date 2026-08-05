/** Fleet 编辑器跨层意图，避免 View 接触可写领域草稿。 */
export type BackupFollowMode = 'ship' | 'position';
export type FleetEditorSlotGroup = 'formation' | 'backup';

export interface FleetEditorSelection {
  readonly group: FleetEditorSlotGroup;
  readonly position: number;
  readonly candidateIndex: number;
}

export type FleetEditorDragSource =
  | { readonly group: 'gallery'; readonly shipId: number }
  | { readonly group: 'formation'; readonly position: number }
  | {
    readonly group: 'backup';
    readonly position: number;
    readonly candidateIndex: number;
  };

export interface FleetRuleUpdate {
  readonly levelEnabled?: boolean;
  readonly minLevel?: number | null;
  readonly maxLevel?: number | null;
}

export type FleetDraftEditIntent =
  | {
    readonly type: 'assign-ship';
    readonly selection: FleetEditorSelection;
    readonly shipId: number;
  }
  | {
    readonly type: 'remove-primary';
    readonly position: number;
    readonly selection: FleetEditorSelection;
  }
  | {
    readonly type: 'remove-candidate';
    readonly position: number;
    readonly candidateIndex: number;
  }
  | { readonly type: 'clear' }
  | { readonly type: 'ensure-candidate'; readonly position: number }
  | {
    readonly type: 'drop-formation';
    readonly source: FleetEditorDragSource;
    readonly targetPosition: number;
    readonly selection: FleetEditorSelection;
    readonly backupFollowMode: BackupFollowMode;
  }
  | {
    readonly type: 'drop-backup';
    readonly source: FleetEditorDragSource;
    readonly targetPosition: number;
    readonly targetCandidateIndex: number;
  }
  | {
    readonly type: 'copy-backups';
    readonly sourcePosition: number;
    readonly targetPosition: number;
  }
  | {
    readonly type: 'update-rule';
    readonly position: number;
    readonly candidateIndex?: number;
    readonly update: FleetRuleUpdate;
  };

export interface FleetDraftEditResult {
  readonly changed: boolean;
  readonly selection?: FleetEditorSelection;
  readonly error?: {
    readonly title: string;
    readonly message: string;
  };
}
