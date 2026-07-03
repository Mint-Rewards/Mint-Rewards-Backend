import { NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brandhub/brands/[brandId]
 * Fetches one brand through the full chain: requireBrandAuth ->
 * requireBrandScope. This is the endpoint the frontend dashboard migrates
 * to from the unauthenticated /brands/:id.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { brandId } = await params;

  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;

  const scope = await requireBrandScope(auth.brandUser, brandId);
  if (scope instanceof NextResponse) return scope;

  await connectToDatabase();

  const brand = await BrandModel.findById(brandId)
    .select("-verificationToken")
    .lean();

  if (!brand) {
    return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  }

  return NextResponse.json({
    brand: {
      id: brand._id.toString(),
      orgId: brand.orgId?.toString() ?? null,
      brandName: brand.brandName,
      companyName: brand.companyName,
      email: brand.email,
      logo: brand.logo ?? null,
      themeImage: brand.themeImage ?? null,
      category: brand.category,
      description: brand.description ?? "",
      address: brand.address ?? "",
      webLink: brand.webLink,
      appLink: brand.appLink ?? "",
      domain: brand.domain ?? "",
      themeColor: brand.themeColor ?? null,
      status: brand.status ?? null,
    },
  });
}
