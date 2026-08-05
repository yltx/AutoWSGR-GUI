/** 编队规划领域合同，不包含 IPC 序列化字段。 */
export type FleetPlanSource = 'system' | 'user';
export type FleetShipVariant = 'normal' | 'refit' | 'special';

export interface FleetShip {
  readonly id: number;
  readonly name: string;
  readonly searchName: string;
  readonly variant: FleetShipVariant;
  readonly rarity: number;
  readonly shipType: string;
  readonly sizeClass: string;
  readonly roleClass: string;
  readonly country: string;
  readonly portraitUrl: string;
  readonly backgroundUrl: string;
  readonly frameUrl: string;
  readonly typeIconUrl: string;
  readonly wikiUrl?: string;
}

export interface FleetShipLabels {
  readonly locale?: string;
  readonly shipTypes: Readonly<Record<string, string>>;
  readonly sizeClasses: Readonly<Record<string, string>>;
  readonly roleClasses: Readonly<Record<string, string>>;
  readonly countries: Readonly<Record<string, string>>;
  readonly variants: Readonly<Record<string, string>>;
}

export interface FleetShipLibrary {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly labels: FleetShipLabels;
  readonly typeGroups: {
    readonly sizeClasses: Readonly<Record<string, readonly string[]>>;
    readonly roleClasses: Readonly<Record<string, readonly string[]>>;
  };
  readonly ships: readonly FleetShip[];
}

export interface FleetTeamShipRule {
  name: string;
  searchName?: string;
  shipTypes?: string[];
  minLevel?: number;
  maxLevel?: number;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface FleetTeamPlanSlot {
  name?: string;
  searchName?: string;
  shipTypes?: string[];
  minLevel?: number;
  maxLevel?: number;
  candidates?: FleetTeamShipRule[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface FleetTeamPlan {
  file?: string;
  name: string;
  ships: FleetTeamPlanSlot[];
  source?: FleetPlanSource;
  modifiedAt?: number;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface FleetTeamPlanSaveResult {
  success: boolean;
  exists?: boolean;
  file?: string;
  plan?: FleetTeamPlan;
  error?: string;
}

export interface FleetTeamPlanListResult {
  plans: FleetTeamPlan[];
  errors: Array<{
    file: string;
    source: FleetPlanSource;
    kind: 'team';
    message: string;
  }>;
}
