import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { CampaignModel } from "@/lib/models";
import { requireAdminAuth } from "@/lib/requireAdminAuth";

export async function GET(req: NextRequest) {
  const auth = requireAdminAuth(req);
  if (auth instanceof NextResponse) return auth;
  try {
    await connectToDatabase();

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const brandId = searchParams.get("brandId");

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status.toUpperCase();
    if (brandId) filter.brand = brandId;

    const campaigns = await CampaignModel.find(filter)
      .sort({ _id: -1 })
      .populate(
        "brand",
        "brandName companyName logo category status themeColor",
      )
      .lean();

    return Response.json({ success: true, campaigns, total: campaigns.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
