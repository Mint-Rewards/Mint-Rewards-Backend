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

/**
 * DEPRECATED for the mobile client.
 *
 * `couponId` is a **campaign** `_id` — this route does
 * `CampaignModel.findById(couponId)`. Three names for one document: the path
 * says coupon, the collection is campaigns, and the payload is called a
 * discount. Under docs/VOCABULARY.md a coupon is only the redemption
 * mechanism (the code returned as `couponCode`), never the incentive itself.
 *
 * The app now claims through POST /api/users/deals/[dealId]/redeem. This route
 * is kept live for clients not yet updated, and is not renamed because the
 * path and response shape are a published contract.
 */
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

    // Load the campaign first so we can validate it BEFORE marking it used.
    // Marking used prematurely (issue #20) permanently locks the user out even
    // when no code can be handed back.
    const campaign = await CampaignModel.findById(couponId).lean();

    if (!campaign) {
      return Response.json(
        { error: "Coupon not found or has already expired." },
        { status: 404 },
      );
    }

    if (campaign.status === "EXPIRED") {
      return Response.json(
        { error: "Coupon not found or has already expired." },
        { status: 404 },
      );
    }

    // "Already used" = this user's ID is already in campaign.users
    const alreadyUsed = (campaign.users ?? []).some((u) =>
      u.equals(userObjectId),
    );
    if (alreadyUsed) {
      return Response.json({ error: "Coupon already used." }, { status: 400 });
    }

    // No code to hand back: do NOT consume the redemption, so the user can try
    // again once the brand adds codes (issue #20).
    const codes = campaign.discountCodes ?? [];
    if (codes.length === 0) {
      return Response.json(
        { error: "This coupon has no discount codes available." },
        { status: 409 },
      );
    }

    // Atomic commit: only mark used if the user is still absent and the
    // campaign has not expired. This preserves the no-double-redeem guarantee.
    const committed = await CampaignModel.findOneAndUpdate(
      {
        _id: couponId,
        status: { $ne: "EXPIRED" },
        users: { $ne: userObjectId },
      },
      { $addToSet: { users: userObjectId } },
      { new: true },
    ).lean();

    // Matched nothing => a concurrent request redeemed for this user first
    // (or the campaign expired in the meantime). Treat as already used.
    if (!committed) {
      return Response.json({ error: "Coupon already used." }, { status: 400 });
    }

    const brand = campaign.brand
      ? await BrandModel.findById(campaign.brand).lean()
      : null;

    const couponCode = campaign.isSingleCode
      ? codes[0]
      : codes[Math.floor(Math.random() * codes.length)];

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
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("[PATCH /api/coupons/:couponId/redeem]", message);
    return Response.json(
      { error: "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}
