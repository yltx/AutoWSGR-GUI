/** 编队规划使用的窄 IPC DTO。 */
export interface ShipLibraryLabels {
  locale?: string;
  ship_types: Record<string, string>;
  size_classes: Record<string, string>;
  role_classes: Record<string, string>;
  countries: Record<string, string>;
  variants: Record<string, string>;
}

export interface ShipLibraryShip {
  id: number;
  name: string;
  search_name: string;
  variant: 'normal' | 'refit' | 'special';
  rarity: number;
  ship_type: string;
  size_class: string;
  role_class: string;
  country: string;
  portraitUrl: string;
  backgroundUrl: string;
  frameUrl: string;
  typeIconUrl: string;
  wiki_url?: string;
}

export interface ShipLibraryManifest {
  schemaVersion: number;
  generatedAt: string;
  labels: ShipLibraryLabels;
  typeGroups: {
    size_classes: Record<string, string[]>;
    role_classes: Record<string, string[]>;
  };
  ships: ShipLibraryShip[];
}

export interface UserTeamShipRule {
  name: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
}

export interface UserTeamPlanSlot {
  name?: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  candidates?: UserTeamShipRule[];
}

export type PlanPresetSource = 'system' | 'user';

export interface UserTeamPlan {
  file?: string;
  name: string;
  ships: UserTeamPlanSlot[];
  source?: PlanPresetSource;
  modifiedAt?: number;
}

export interface UserTeamPlanResult {
  success: boolean;
  exists?: boolean;
  file?: string;
  plan?: UserTeamPlan;
  error?: string;
}

export interface UserTeamPlanListResult {
  plans: UserTeamPlan[];
  errors: Array<{
    file: string;
    source: PlanPresetSource;
    kind: 'team';
    message: string;
  }>;
}
