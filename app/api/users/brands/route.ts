import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel } from "@/lib/models";

/**
 * GET /api/users/brands
 *
 * App-facing list of APPROVED brands, independent of whether any of them
 * currently has a live deal.
 *
 * GET /api/users/deals embeds a brand on every deal row, and the app used to
 * derive its whole brand list from that payload — which meant a brand approved
 * in BrandHub was invisible in the app until its first deal went live. This
 * route is the brand list itself, so approval alone is enough to appear.
 *
 * The projection is deliberately identical to the `brand` sub-document that
 * /api/users/deals returns, so the client can merge the two by `_id` without
 * either source carrying fields the other lacks.
 *
 * This is not /api/brands/fetch: that route is admin-authenticated and returns
 * full brand records plus campaigns and deals. Consumers get approved brands
 * and nothing else.
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

    // Same sort as /api/users/deals (`_id: -1`, newest first) so a brand does
    // not jump position depending on which of the two payloads introduced it.
    const brands = await BrandModel.find({ status: "APPROVED" })
      .select("_id companyName brandName logo themeColor category")
      .sort({ _id: -1 })
      .lean();

    return Response.json({
      brands: brands.map((brand) => ({
        _id: brand._id,
        companyName: brand.companyName,
        brandName: brand.brandName,
        logo: brand.logo,
        themeColor: brand.themeColor,
        category: brand.category,
      })),
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Your request could not be processed. Please try again.";
    return Response.json({ error: message }, { status: 500 });
  }
}
