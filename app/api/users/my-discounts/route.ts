import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel } from "@/lib/models";
import { isCampaignActive } from "@/lib/campaignDates";
import mongoose from "mongoose";

const normalize = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

/**
 * DEPRECATED for the mobile client.
 *
 * This route serves *campaigns* under a "discounts" name — a naming carryover
 * predating docs/VOCABULARY.md, where a Deal is the consumer incentive and a
 * Discount is one type of Deal. The app now reads /api/users/deals instead.
 * Kept live for any client not yet updated; not renamed, because the response
 * key `discounts` and the body field `discountId` are a published contract.
 */
export async function GET(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Campaigns are moderated here (this previously filtered on
    // `$ne: "EXPIRED"`, so a BrandHub submission was listed the moment it was
    // created). Brands are deliberately NOT filtered by status: production's
    // real brands are clones inserted as PENDING, and requiring APPROVED
    // emptied the consumer brand list — see the note in
    // app/api/users/active-campaigns/route.ts. Add `status: "APPROVED"` back
    // here at the same time as there.
    const [campaigns, brands] = await Promise.all([
      CampaignModel.find({ status: "APPROVED" }).lean(),
      BrandModel.find().lean(),
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
        const brand = brandByRegistration.get(
          normalize(campaign.brandRegistration),
        );
        if (!brand) return null;

        const isAvailed =
          Array.isArray(campaign.users) &&
          campaign.users.some((u) => u.toString() === userId);

        // APPROVED alone is not enough: nothing in the codebase ever sets
        // status EXPIRED, so an expired campaign stays APPROVED forever and
        // was still being listed as claimable.
        //
        // This screen doubles as the user's redemption history, so a campaign
        // the user already claimed is kept past its end date; one they never
        // claimed is dropped, since it can no longer be redeemed.
        if (!isCampaignActive(campaign) && !isAvailed) return null;

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
      {
        error:
          error?.message ||
          "Your request could not be processed. Please try again.",
      },
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
      return Response.json(
        { error: "discountId is required." },
        { status: 400 },
      );
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

    // Unlike GET, there is no already-claimed exemption here: history is for
    // reading, not for claiming. A code must never be issued for a campaign
    // whose end date has passed.
    if (!isCampaignActive(campaign)) {
      return Response.json(
        { error: "This campaign has ended." },
        { status: 410 },
      );
    }

    if (!campaign.discountCodes || campaign.discountCodes.length === 0) {
      return Response.json(
        { error: "No discount codes available." },
        { status: 404 },
      );
    }

    const code = campaign.isSingleCode
      ? campaign.discountCodes[0]
      : campaign.discountCodes[
          Math.floor(Math.random() * campaign.discountCodes.length)
        ];

    return Response.json({ code });
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
      return Response.json(
        { error: "discountId is required." },
        { status: 400 },
      );
    }

    // Approved only, matching PATCH — marking an unmoderated campaign as
    // availed would burn the user's one redemption on it.
    const campaign = await CampaignModel.findOne({
      _id: discountId,
      status: "APPROVED",
    }).lean();

    if (!campaign) {
      return Response.json({ error: "Campaign not found." }, { status: 404 });
    }

    // Checked before the write, matching PATCH: an expired campaign must not
    // consume the user's redemption.
    if (!isCampaignActive(campaign)) {
      return Response.json(
        { error: "This campaign has ended." },
        { status: 410 },
      );
    }

    await CampaignModel.updateOne(
      { _id: discountId, status: "APPROVED" },
      { $addToSet: { users: new mongoose.Types.ObjectId(userId) } },
    );

    return Response.json({ success: true });
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
