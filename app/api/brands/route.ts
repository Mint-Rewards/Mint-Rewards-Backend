import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel } from "@/lib/models";
import { Brand, Campaign } from "@/lib/types";

export async function GET() {
  try {
    await connectToDatabase();

    const normalizeRegistration = (value: unknown) =>
      String(value ?? "")
        .trim()
        .toLowerCase();

    const brands = await BrandModel.find({
      status: "PENDING",
    }).lean<Brand[]>();
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
