import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

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

/**
 * POST /api/brandhub/brands
 * Body: { brandName: string; companyName: string }
 * Creates a brand in the caller's org. Owner/admin only. orgId always comes
 * from the JWT payload, never the request body — callers must not be able
 * to create brands in other orgs.
 */
export async function POST(req: NextRequest) {
  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { brandUser } = auth;

  if (brandUser.orgRole !== "owner" && brandUser.orgRole !== "admin") {
    return NextResponse.json(
      { error: "Only owners and admins can create brands" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    brandName?: string;
    companyName?: string;
  } | null;

  const { brandName, companyName } = body ?? {};

  if (!brandName || !companyName) {
    return NextResponse.json(
      { error: "brandName and companyName are required" },
      { status: 400 },
    );
  }

  await connectToDatabase();

  // The legacy Brand schema requires several fields (with unique indexes on
  // email and registrationNumber) that a hub-created brand doesn't have yet
  // — fill them with unique placeholders keyed to the brand id.
  const brandId = new Types.ObjectId();
  const brand = await BrandModel.create({
    _id: brandId,
    orgId: new Types.ObjectId(brandUser.orgId),
    brandName,
    companyName,
    email: `brand-${brandId.toString()}@brandhub.local`,
    category: "general",
    webLink: "https://example.com",
    contactName: companyName,
    phone: "N/A",
    registrationNumber: `BH-${brandId.toString()}`,
  });

  return NextResponse.json(
    {
      brand: {
        id: brand._id.toString(),
        orgId: brand.orgId?.toString() ?? null,
        brandName: brand.brandName,
        companyName: brand.companyName,
        logo: brand.logo ?? null,
      },
    },
    { status: 201 },
  );
}
