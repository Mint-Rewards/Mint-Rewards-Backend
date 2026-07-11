// Module catalogue for BrandHub RBAC. Edit MODULE_CATALOGUE to add, rename,
// or remove modules — module IDs are validated at the application layer via
// isValidModuleId, not locked into a schema enum, so this is a one-line edit.

import type { ModuleSubscription } from "@/lib/types";

export interface ModuleDefinition {
  id: string;
  name: string;
  locked?: boolean; // true = org always has an active subscription, cannot be removed
}

export const MODULE_CATALOGUE: ModuleDefinition[] = [
  // Campaigns, deals, and the impact/analytics overview.
  { id: "consumer-reporting", name: "Consumer Reporting" },
  { id: "esg", name: "ESG Reporting" },
  { id: "collections", name: "Collections" },
  { id: "minttrace", name: "MintTrace" },
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

// Single place subscription semantics live — middleware and any future
// billing code both call this. Trial counts as access-granting, and expiry
// is checked lazily at request time (no cron needed to flip statuses).
export function hasActiveSubscription(
  subscriptions: ModuleSubscription[],
  moduleId: string,
  now: Date = new Date(),
): boolean {
  const sub = subscriptions.find((s) => s.module === moduleId);
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "trial") return false;
  if (sub.expiresAt && new Date(sub.expiresAt) < now) return false;
  return true;
}

export interface BrandJwtPayload {
  sub: string;
  orgId: string;
  orgRole: OrgRole;
  moduleAccess: ModuleAccessEntry[];
}
