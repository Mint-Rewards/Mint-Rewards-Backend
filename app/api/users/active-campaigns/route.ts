import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel } from "@/lib/models";
import { isCampaignActive } from "@/lib/campaignDates";
import { legacyBrandIdOf } from "@/lib/legacyBrandEmail";

const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase();

/**
 * Brands exist twice in the data: an original legacy document, and the PENDING
 * BrandHub document created from it by scripts/clone-legacy-brands.js. The two
 * carry different `_id`s, and a campaign may reference either one — campaigns
 * created since the migration point `brand` at the BrandHub document, while
 * older ones still carry the legacy id in `brand` and/or `brandId`.
 *
 * A campaign whose `brand` is not one of the listed brands' ids can't be joined
 * by any consumer, so every brand card renders "No active campaigns". Resolve
 * each campaign onto a listed brand using whichever link survived:
 *   - `brand`             — already a listed brand (the normal case)
 *   - `brandId`           — the other document's id, kept when campaigns were repointed
 *   - `brandRegistration` — business key matching a listed brand's registrationNumber
 *   - the BrandHub document's `legacyBrandId`, which pairs the two ids together
 *     in either direction
 */
function resolveListedBrandId(
  campaign: { brand?: unknown; brandId?: unknown; brandRegistration?: unknown },
  listedById: Map<string, unknown>,
  listedByRegistration: Map<string, string>,
  listedIdByPairedId: Map<string, string>,
): string | null {
  const brand = String(campaign.brand ?? "");
  if (listedById.has(brand)) return brand;

  const brandId = String(campaign.brandId ?? "");
  if (listedById.has(brandId)) return brandId;

  const byRegistration = listedByRegistration.get(
    normalize(campaign.brandRegistration),
  );
  if (byRegistration) return byRegistration;

  return listedIdByPairedId.get(brand) ?? listedIdByPairedId.get(brandId) ?? null;
}

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

    // PENDING, deliberately, until the BrandHub moderation work lands.
    //
    // Every real brand in production is a clone written by
    // scripts/clone-legacy-brands.js, and clones are inserted PENDING. Listing
    // APPROVED instead — correct moderation, but ahead of the data — emptied
    // the app's brand list on 2026-08-09: users saw only the two brands that
    // happened to be APPROVED and reported the app was "showing the test
    // database". Approving the clones (scripts/approve-legacy-clones.js) is
    // what makes the APPROVED filter safe; restore it once that has run.
    const listedBrands = await BrandModel.find({
      status: "PENDING",
    });

    // A cloned BrandHub document carries `legacyBrandId`, pairing it with the
    // legacy document it was cloned from. Both can be listed at once, which
    // would render the same brand twice in the app, so a legacy document is
    // dropped as soon as its clone is listed. The clone is the survivor: it is
    // the document BrandHub edits.
    const supersededLegacyIds = new Set(
      listedBrands
        .map((b) => legacyBrandIdOf(b))
        .filter((id): id is string => id !== null),
    );

    const activeBrands = listedBrands.filter(
      (b) => !supersededLegacyIds.has(b._id.toString()),
    );

    // APPROVED alone is not enough: an expired-but-still-APPROVED campaign
    // must not be reported as active. Filter by real start/end dates too.
    // .lean(): `brandId` is not in CampaignSchema, so a hydrated document would
    // drop the very field that links a repointed campaign back to its original
    // brand. Lean docs come straight from MongoDB and keep it.
    const approvedCampaigns = await CampaignModel.find({
      status: "APPROVED",
    }).lean();

    const listedById = new Map<string, unknown>(
      activeBrands.map((b) => [b._id.toString(), b]),
    );
    const listedByRegistration = new Map<string, string>(
      activeBrands
        .filter((b) => normalize(b.registrationNumber))
        .map((b) => [normalize(b.registrationNumber), b._id.toString()]),
    );

    // A cloned BrandHub document carries `legacyBrandId`, pairing it with the
    // legacy document it was cloned from. Map the id that is NOT listed onto
    // the one that is, so the pairing works whichever of the two a campaign
    // happens to reference.
    //
    // Indexed, unlike the `email: { $regex: /^legacy-.../ }` this replaced,
    // which scanned the whole brands collection on every request. Clones
    // written before the field existed need scripts/approve-legacy-clones.js
    // to backfill it.
    const pairedBrands = await BrandModel.find({
      legacyBrandId: { $ne: null },
    }).select("_id legacyBrandId");
    const listedIdByPairedId = new Map<string, string>();
    for (const paired of pairedBrands) {
      const brandHubId = paired._id.toString();
      const legacyId = String(paired.legacyBrandId);
      if (listedById.has(brandHubId)) {
        listedIdByPairedId.set(legacyId, brandHubId);
      } else if (listedById.has(legacyId)) {
        listedIdByPairedId.set(brandHubId, legacyId);
      }
    }

    const activeCampaigns = approvedCampaigns
      .filter((c) => isCampaignActive(c))
      .map((campaign) => {
        const brandId = resolveListedBrandId(
          campaign,
          listedById,
          listedByRegistration,
          listedIdByPairedId,
        );
        if (!brandId) return null;
        // Consumers join on `brand`; hand them the id they can actually match.
        return { ...campaign, brand: brandId };
      })
      .filter(Boolean);

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
