import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel } from "@/lib/models";
import { isCampaignActive } from "@/lib/campaignDates";

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
 *   - the BrandHub document's `legacy-<legacyId>@example.com` email, which pairs
 *     the two ids together in either direction
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

    // Campaigns are linked against the PENDING BrandHub brand documents, so
    // that is the set the app lists and joins against.
    const activeBrands = await BrandModel.find({
      status: "PENDING",
    });

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

    // A BrandHub document carries `legacy-<legacyId>@example.com`, pairing it
    // with the legacy document it was cloned from. Map the id that is NOT
    // listed onto the one that is, so the pairing works whichever of the two
    // a campaign happens to reference.
    const pairedBrands = await BrandModel.find({
      email: { $regex: /^legacy-[0-9a-f]{24}@example\.com$/i },
    }).select("_id email");
    const listedIdByPairedId = new Map<string, string>();
    for (const paired of pairedBrands) {
      const brandHubId = paired._id.toString();
      const legacyId = String(paired.email ?? "").slice(
        "legacy-".length,
        "legacy-".length + 24,
      );
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
