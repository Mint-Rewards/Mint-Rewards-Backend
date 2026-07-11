import { NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { OrganizationModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import {
  hasActiveSubscription,
  hasPermission,
  type ModuleId,
  type PermissionLevel,
} from "@/lib/modules";
import type { BrandJwtPayload } from "@/lib/modules";

type AuthOk = { brandUser: BrandJwtPayload };

/**
 * Call at the top of any BrandHub route handler that is scoped to a single
 * module. Runs the full chain: verify JWT -> org subscription check ->
 * owner/admin bypass -> per-user module access -> permission level.
 *
 * Usage:
 *   const auth = await requireModuleAccess(req, "consumer-reporting", "write");
 *   if (auth instanceof NextResponse) return auth;
 *   // auth.brandUser is now available
 */
export async function requireModuleAccess(
  req: NextRequest,
  moduleName: ModuleId,
  requiredPermission: PermissionLevel,
): Promise<AuthOk | NextResponse> {
  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { brandUser } = auth;

  await connectToDatabase();

  const org = await OrganizationModel.findById(brandUser.orgId)
    .select("moduleSubscriptions")
    .lean();

  if (!org || !hasActiveSubscription(org.moduleSubscriptions, moduleName)) {
    return NextResponse.json(
      { error: "No active subscription for this module" },
      { status: 402 },
    );
  }

  if (brandUser.orgRole === "owner" || brandUser.orgRole === "admin") {
    return { brandUser };
  }

  const entry = brandUser.moduleAccess.find((m) => m.module === moduleName);
  if (!entry) {
    return NextResponse.json(
      { error: "No access to this module" },
      { status: 403 },
    );
  }

  if (!hasPermission(entry.permissions, requiredPermission)) {
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 },
    );
  }

  return { brandUser };
}
