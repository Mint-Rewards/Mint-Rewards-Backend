import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel } from "@/lib/models";
import { isCampaignActive } from "@/lib/campaignDates";

export async function GET(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const activeBrands = await BrandModel.find({
      status: "APPROVED",
    });

    // APPROVED alone is not enough: an expired-but-still-APPROVED campaign
    // must not be reported as active. Filter by real start/end dates too.
    const approvedCampaigns = await CampaignModel.find({
      status: "APPROVED",
    });
    const activeCampaigns = approvedCampaigns.filter((c) =>
      isCampaignActive(c),
    );

    return Response.json({
      activeBrands,
      activeCampaigns,
    });
  } catch (error: any) {
    return Response.json(
      {
        error:
          error?.message ||
          "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
