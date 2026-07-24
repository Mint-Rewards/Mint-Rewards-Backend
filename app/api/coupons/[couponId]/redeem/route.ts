import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel } from "@/lib/models";
import mongoose from "mongoose";

function generateReferenceCode(couponId: string): string {
  const suffix = couponId.slice(-4).toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase().slice(-5);
  return `${suffix}-${timestamp}-MR`;
}

interface RouteParams {
  params: Promise<{ couponId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { couponId } = await params;

    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
      return Response.json({ error: "Invalid coupon ID." }, { status: 400 });
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);

    // "Already used" = this user's ID is already in campaign.users
    const existing = await CampaignModel.findOne({
      _id: couponId,
      users: userObjectId,
    }).lean();

    if (existing) {
      return Response.json(
        { error: "Coupon already used." },
        { status: 400 },
      );
    }

    const campaign = await CampaignModel.findOneAndUpdate(
      {
        _id: couponId,
        status: { $ne: "EXPIRED" },
        users: { $ne: userObjectId },
      },
      { $addToSet: { users: userObjectId } },
      { new: true },
    ).lean();

    if (!campaign) {
      return Response.json(
        { error: "Coupon not found or has already expired." },
        { status: 404 },
      );
    }

    const brand = campaign.brand
      ? await BrandModel.findById(campaign.brand).lean()
      : null;

    const couponCode = campaign.isSingleCode
      ? campaign.discountCodes[0]
      : campaign.discountCodes[Math.floor(Math.random() * campaign.discountCodes.length)];

    const referenceCode = generateReferenceCode(couponId);

    return Response.json({
      couponCode,
      referenceCode,
      coupon: {
        id: couponId,
        name: campaign.name,
        discountPercentage: campaign.discountPercentage ?? null,
        endDate: campaign.endDate,
        usageType: "SINGLE USE",
        redeemedAt: new Date().toISOString(),
        brand: brand
          ? {
              companyName: brand.companyName,
              logo: brand.logo ?? null,
              webLink: brand.webLink ?? null,
            }
          : null,
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    console.error("[PATCH /api/coupons/:couponId/redeem]", message);
    return Response.json(
      { error: "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}
