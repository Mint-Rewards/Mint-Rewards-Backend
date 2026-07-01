// Module catalogue for BrandHub RBAC. Edit MODULE_CATALOGUE to add, rename,
// or remove modules — module IDs are validated at the application layer via
// isValidModuleId, not locked into a schema enum, so this is a one-line edit.

export interface ModuleDefinition {
  id: string;
  name: string;
  locked?: boolean; // true = always in org.subscribedModules, cannot be removed
}

export const MODULE_CATALOGUE: ModuleDefinition[] = [
  { id: "b2c", name: "Consumer campaigns" },
  { id: "b2b", name: "Partner management" },
  { id: "analytics", name: "Reporting & dashboards" },
  { id: "minttrace", name: "Blockchain traceability" },
  { id: "rewards", name: "Reward catalog" },
  { id: "settings", name: "Org configuration", locked: true },
];

export const MODULE_IDS: string[] = MODULE_CATALOGUE.map((m) => m.id);
export const LOCKED_MODULES: string[] = MODULE_CATALOGUE.filter(
  (m) => m.locked,
).map((m) => m.id);

export type ModuleId = string;

export function isValidModuleId(id: string): boolean {
  return MODULE_IDS.includes(id);
}

export const PERMISSION_LEVELS = ["read", "write", "manage"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

// Hierarchical: manage implies write implies read.
export const PERMISSION_RANK: Record<PermissionLevel, number> = {
  read: 1,
  write: 2,
  manage: 3,
};

export function hasPermission(
  userPermissions: PermissionLevel[],
  required: PermissionLevel,
): boolean {
  return userPermissions.some(
    (p) => PERMISSION_RANK[p] >= PERMISSION_RANK[required],
  );
}

export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export interface ModuleAccessEntry {
  module: ModuleId;
  permissions: PermissionLevel[];
}

export interface BrandJwtPayload {
  sub: string;
  orgId: string;
  orgRole: OrgRole;
  moduleAccess: ModuleAccessEntry[];
}
