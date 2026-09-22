import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { findBrandsByIds } from "@/lib/repositories/brandhub";
import { findDeals } from "@/lib/repositories/deals";
import { requireAdminAuth } from "@/lib/requireAdminAuth";

export async function GET(req: NextRequest) {
  const auth = requireAdminAuth(req);
  if (auth instanceof NextResponse) return auth;
  try {
    await connectToDatabase();

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const brandId = searchParams.get("brandId");

    const deals = await findDeals({
      status: status ? status.toLowerCase() : undefined,
      brand: brandId ?? undefined,
    });

    // What `.populate("brand", ...)` used to do. The deal is still a Mongo
    // document and the brand is not, so the join is done here: one query for
    // the brands referenced, then the same projection populate was given.
    const brandsById = await findBrandsByIds(
      deals.map((row) => String(row.brand ?? "")),
    );
    const withBrand = deals.map((row) => {
      const brand = brandsById.get(String(row.brand ?? ""));
      return {
        ...row,
        brand: brand
          ? {
              _id: brand._id,
              brandName: brand.brandName,
              companyName: brand.companyName,
              logo: brand.logo,
              category: brand.category,
              status: brand.status,
              themeColor: brand.themeColor,
            }
          : null,
      };
    });

    return Response.json({
      success: true,
      deals: withBrand,
      total: withBrand.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
