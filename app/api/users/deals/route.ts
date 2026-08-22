import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, DealModel } from "@/lib/models";

/**
 * GET /api/users/deals
 *
 * App-facing list of redeemable BrandHub deals. Deals live in their own
 * collection and previously had no consumer route at all, so a brand could
 * upload codes, get the deal approved, and no user could ever see it.
 *
 * `codes` is deliberately never returned: the inventory is the thing being
 * rationed, and handing the whole array to every client would let one user
 * take every code. A user receives exactly one code, from POST
 * /api/users/deals/[dealId]/redeem. Deals this user has already claimed come
 * back with their own code attached.
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

    // "active" is the approved state for a deal; "pending" is awaiting review
    // and "inactive" is a brand pausing its own deal.
    const deals = await DealModel.find({ status: "active" })
      .sort({ _id: -1 })
      .lean();

    // Only surface deals whose brand is itself approved, so brand moderation
    // and deal moderation cannot disagree.
    const approvedBrands = await BrandModel.find({ status: "APPROVED" })
      .select("_id companyName brandName logo themeColor category")
      .lean();
    const brandById = new Map(approvedBrands.map((b) => [b._id.toString(), b]));

    const now = Date.now();
    const isLive = (deal: {
      startDate?: string | null;
      endDate?: string | null;
    }) => {
      const start = deal.startDate ? Date.parse(deal.startDate) : NaN;
      const end = deal.endDate ? Date.parse(deal.endDate) : NaN;
      if (!Number.isNaN(start) && now < start) return false;
      if (!Number.isNaN(end) && now > end) return false;
      return true;
    };

    const visible = deals
      .filter(isLive)
      .map((deal) => {
        const brand = brandById.get(String(deal.brand));
        if (!brand) return null;

        const claim = (deal.claims ?? []).find(
          (c) => c.user?.toString() === userId,
        );
        const codesLeft = (deal.codes ?? []).length - (deal.currentUses ?? 0);

        return {
          _id: deal._id,
          title: deal.title,
          description: deal.description ?? "",
          discountPercentage: deal.discountPercentage ?? null,
          discountAmount: deal.discountAmount ?? null,
          minimumPurchase: deal.minimumPurchase ?? null,
          startDate: deal.startDate ?? null,
          endDate: deal.endDate ?? null,
          brand: {
            _id: brand._id,
            companyName: brand.companyName,
            brandName: brand.brandName,
            logo: brand.logo,
            themeColor: brand.themeColor,
            category: brand.category,
          },
          isAvailed: !!claim,
          // Present only once this user has claimed it.
          code: claim?.code ?? null,
          soldOut: !claim && codesLeft <= 0,
        };
      })
      .filter(Boolean);

    return Response.json({ deals: visible });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Your request could not be processed. Please try again.";
    return Response.json({ error: message }, { status: 500 });
  }
}
