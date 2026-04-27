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

    const [campaigns, brands] = await Promise.all([
      CampaignModel.find({ status: { $ne: "EXPIRED" } }).lean(),
      BrandModel.find().lean(),
    ]);

    const brandByRegistration = new Map(
      brands.map((b) => [normalize(b.registrationNumber), b]),
    );

    const userObjectId = new mongoose.Types.ObjectId(userId);

    const discounts = campaigns
      .map((campaign) => {
        const brand = brandByRegistration.get(normalize(campaign.brandRegistration));
        if (!brand) return null;

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
          isAvailed: campaign.users?.some(
            (u) => u.toString() === userObjectId.toString(),
          ) ?? false,
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

    const campaign = await CampaignModel.findOneAndUpdate(
      { _id: discountId, status: { $ne: "EXPIRED" } },
      { $addToSet: { users: new mongoose.Types.ObjectId(userId) } },
      { new: true },
    );

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
