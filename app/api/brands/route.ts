import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { findBrands, type BrandDoc } from "@/lib/repositories/brandhub";
import {
  findCampaigns,
  type CampaignDoc,
} from "@/lib/repositories/deals";
import { requireAdminAuth } from "@/lib/requireAdminAuth";

export async function GET(req: NextRequest) {
  const auth = requireAdminAuth(req);
  if (auth instanceof NextResponse) return auth;
  try {
    await connectToDatabase();

    const normalizeRegistration = (value: unknown) =>
      String(value ?? "")
        .trim()
        .toLowerCase();

    const brands = await findBrands();
    const campaigns = await findCampaigns({ notExpired: true });

    const campaignByRegistration = new Map<string, CampaignDoc[]>();

    for (const campaign of campaigns) {
      const key = normalizeRegistration(campaign.brandRegistration);

      if (!key) {
        continue;
      }

      if (!campaignByRegistration.has(key)) {
        campaignByRegistration.set(key, []);
      }

      campaignByRegistration.get(key)!.push(campaign);
    }

    const brandsWithCampaigns: (BrandDoc & { campaigns: CampaignDoc[] })[] =
      brands.map((brand) => {
        const key = normalizeRegistration(brand.registrationNumber);
        const campaigns = key ? campaignByRegistration.get(key) : undefined;
        return { ...brand, campaigns: campaigns || [] };
      });

    return Response.json({
      success: true,
      brands: brandsWithCampaigns,
    });
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
