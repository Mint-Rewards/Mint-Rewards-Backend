import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel } from "@/lib/models";
import mongoose from "mongoose";

const normalize = (value: unknown) =>
  String(value ?? "").trim().toLowerCase();

export async function GET(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // APPROVED only, on both sides of the join: this previously filtered
    // campaigns on `$ne: "EXPIRED"` and did not filter brands at all, so a
    // campaign submitted in BrandHub was listed to users the moment it was
    // created, before any moderation.
    const [campaigns, brands] = await Promise.all([
      CampaignModel.find({ status: "APPROVED" }).lean(),
      BrandModel.find({ status: "APPROVED" }).lean(),
    ]);

    // Brands with no registrationNumber would all collapse onto the "" key and
    // wrongly match any campaign that also lacks one, so empty keys are
    // dropped rather than joined.
    const brandByRegistration = new Map(
      brands
        .filter((b) => normalize(b.registrationNumber))
        .map((b) => [normalize(b.registrationNumber), b]),
    );

    const discounts = campaigns
      .map((campaign) => {
        const brand = brandByRegistration.get(normalize(campaign.brandRegistration));
        if (!brand) return null;

        const isAvailed = Array.isArray(campaign.users) &&
          campaign.users.some((u) => u.toString() === userId);

        return {
          _id: campaign._id,
          name: campaign.name,
          discountPercentage: campaign.discountPercentage,
          brand: {
            _id: brand._id,
            companyName: brand.companyName,
            logo: brand.logo,
            themeColor: brand.themeColor,
            category: brand.category,
          },
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          isAvailed,
        };
      })
      .filter(Boolean);

    return Response.json({ discounts });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { discountId } = await req.json();

    if (!discountId) {
      return Response.json({ error: "discountId is required." }, { status: 400 });
    }

    // Approved only — a code must never be issued for a campaign that has not
    // cleared moderation.
    const campaign = await CampaignModel.findOne({
      _id: discountId,
      status: "APPROVED",
    }).lean();

    if (!campaign) {
      return Response.json({ error: "Campaign not found." }, { status: 404 });
    }

    if (!campaign.discountCodes || campaign.discountCodes.length === 0) {
      return Response.json({ error: "No discount codes available." }, { status: 404 });
    }

    const code = campaign.isSingleCode
      ? campaign.discountCodes[0]
      : campaign.discountCodes[Math.floor(Math.random() * campaign.discountCodes.length)];

    return Response.json({ code });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { discountId } = await req.json();

    if (!discountId) {
      return Response.json({ error: "discountId is required." }, { status: 400 });
    }

    // Approved only, matching PATCH — marking an unmoderated campaign as
    // availed would burn the user's one redemption on it.
    const campaign = await CampaignModel.findOneAndUpdate(
      { _id: discountId, status: "APPROVED" },
      { $addToSet: { users: new mongoose.Types.ObjectId(userId) } },
      { new: true },
    );

    if (!campaign) {
      return Response.json({ error: "Campaign not found." }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}
