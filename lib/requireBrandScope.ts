import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { findBrandById, type BrandDoc } from "@/lib/repositories/brandhub";
import type { BrandJwtPayload } from "@/lib/modules";

type ScopeOk = { brand: BrandDoc };

/**
 * Call after requireBrandAuth in any route scoped to a single brand:
 * verifies the brand exists AND belongs to the caller's org.
 *
 * Usage:
 *   const scope = await requireBrandScope(auth.brandUser, brandId);
 *   if (scope instanceof NextResponse) return scope;
 *   // scope.brand is now available
 */
export async function requireBrandScope(
  payload: BrandJwtPayload,
  brandId: string,
): Promise<ScopeOk | NextResponse> {
  const notFound = NextResponse.json(
    { error: "Brand not found" },
    { status: 404 },
  );

  if (!Types.ObjectId.isValid(brandId)) {
    return notFound;
  }

  const brand = await findBrandById(brandId);
  if (!brand) {
    return notFound;
  }
  if (!brand.orgId || brand.orgId !== payload.orgId) {
    // Legacy brands with no orgId are not accessible via brandhub auth —
    // they must be adopted into an org first. 404 (not 403) to avoid
    // confirming the brand exists to callers outside its org.
    return notFound;
  }
  return { brand };
}
