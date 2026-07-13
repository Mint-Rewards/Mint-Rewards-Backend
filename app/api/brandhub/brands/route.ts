import { NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";

/**
 * GET /api/brandhub/brands
 * Lists the caller's org's brands. requireBrandAuth only — no module gate,
 * brand listing is org-level, not a module feature.
 */
export async function GET(req: NextRequest) {
  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;

  await connectToDatabase();

  const brands = await BrandModel.find({ orgId: auth.brandUser.orgId })
    .select("_id brandName companyName logo")
    .lean();

  return NextResponse.json({
    brands: brands.map((b) => ({
      id: b._id.toString(),
      brandName: b.brandName,
      companyName: b.companyName,
      logo: b.logo ?? null,
    })),
  });
}
