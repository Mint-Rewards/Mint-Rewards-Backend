import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel } from "@/lib/models";
import { Brand, Campaign } from "@/lib/types";
import { requireAdminAuth } from "@/lib/requireAdminAuth";
import { getAuthenticatedUserId } from "@/lib/auth";

export async function GET(req: NextRequest) {
  // The mobile app's redeem screen reads this endpoint with an ordinary user
  // token, and shipped clients cannot be force-upgraded — admin-only access
  // here 401s them, which trips the global sign-out in authenticatedFetch.
  // Admins keep the unfiltered list; users get the same PENDING-only slice
  // this endpoint returned before it was gated.
  const admin = requireAdminAuth(req);
  const isAdmin = !(admin instanceof NextResponse);

  if (!isAdmin) {
    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return NextResponse.json({ error: "No token provided" }, { status: 401 });
    }
  }

  try {
    await connectToDatabase();

    const normalizeRegistration = (value: unknown) =>
      String(value ?? "")
        .trim()
        .toLowerCase();

    const brands = await BrandModel.find(
      isAdmin ? {} : { status: "PENDING" },
    ).lean<Brand[]>();
    const campaigns = await CampaignModel.find({
      status: { $ne: "EXPIRED" },
    }).lean<Campaign[]>();

    const campaignByRegistration = new Map<string, Campaign[]>();

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

    const brandsWithCampaigns: (Brand & { campaigns: Campaign[] })[] =
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
