import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { findBrands } from "@/lib/repositories/brandhub";
import { findCampaigns, findDeals } from "@/lib/repositories/deals";
import { requireAdminAuth } from "@/lib/requireAdminAuth";

const normalize = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

/**
 * GET /api/brands/fetch
 *
 * Approved inventory only: APPROVED brands, each with their APPROVED campaigns
 * and "active" deals ("active" is the approved state in the deal status enum).
 * Nothing awaiting or refused review appears here.
 *
 * This is not the moderation queue — GET /api/brands returns every brand
 * regardless of status, and GET /api/brands/deals?status=pending lists deals
 * awaiting review.
 */
export async function GET(req: NextRequest) {
  const auth = requireAdminAuth(req);
  if (auth instanceof NextResponse) return auth;
  try {
    await connectToDatabase();

    // Newest first, as `sort({ _id: -1 })` meant — see findBrands.
    const brands = await findBrands({ status: "APPROVED" });

    const brandIds = brands.map((b) => b._id);

    const [campaigns, deals] = await Promise.all([
      findCampaigns({ status: "APPROVED" }),
      findDeals({ status: "active", brandIds: brandIds }),
    ]);

    // Campaigns link to a brand by `brand` id, but older records only carry
    // the `brandRegistration` business key — index both so neither is dropped.
    const campaignsByBrandId = new Map<string, unknown[]>();
    const byRegistration = new Map<string, string>(
      brands
        .filter((b) => normalize(b.registrationNumber))
        .map((b) => [normalize(b.registrationNumber), b._id.toString()]),
    );
    const listed = new Set(brandIds.map((id) => id.toString()));

    for (const campaign of campaigns) {
      const direct = String(campaign.brand ?? "");
      const brandId = listed.has(direct)
        ? direct
        : byRegistration.get(normalize(campaign.brandRegistration));
      if (!brandId) continue; // brand is not approved — omit the campaign
      if (!campaignsByBrandId.has(brandId)) campaignsByBrandId.set(brandId, []);
      campaignsByBrandId.get(brandId)!.push(campaign);
    }

    const dealsByBrandId = new Map<string, unknown[]>();
    for (const deal of deals) {
      const brandId = String(deal.brand);
      if (!dealsByBrandId.has(brandId)) dealsByBrandId.set(brandId, []);
      dealsByBrandId.get(brandId)!.push(deal);
    }

    const withInventory = brands.map((brand) => {
      const id = brand._id.toString();
      return {
        ...brand,
        campaigns: campaignsByBrandId.get(id) ?? [],
        deals: dealsByBrandId.get(id) ?? [],
      };
    });

    return Response.json({ success: true, brands: withInventory });
  } catch (error: any) {
    return Response.json(
      {
        success: false,
        message: "Server error",
        error: error?.message || "Unexpected error",
      },
      { status: 500 },
    );
  }
}
