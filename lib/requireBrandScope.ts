import { NextResponse } from "next/server";
import { Types } from "mongoose";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import type { BrandJwtPayload } from "@/lib/modules";
import type { BrandDocument } from "@/lib/types";

type ScopeOk = { brand: Pick<BrandDocument, "_id" | "orgId"> };

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

  await connectToDatabase();

  const brand = await BrandModel.findById(brandId).select("orgId").lean();
  if (!brand) {
    return notFound;
  }
  if (!brand.orgId || brand.orgId.toString() !== payload.orgId) {
    // Legacy brands with no orgId are not accessible via brandhub auth —
    // they must be adopted into an org first. 404 (not 403) to avoid
    // confirming the brand exists to callers outside its org.
    return notFound;
  }
  return { brand };
}
