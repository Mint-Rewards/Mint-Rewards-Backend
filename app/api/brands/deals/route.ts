import { type NextRequest } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { DealModel } from "@/lib/models";

export async function GET(req: NextRequest) {
  try {
    await connectToDatabase();

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const brandId = searchParams.get("brandId");

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status.toLowerCase();
    if (brandId) filter.brand = brandId;

    const deals = await DealModel.find(filter)
      .sort({ _id: -1 })
      .populate("brand", "brandName companyName logo category status themeColor")
      .lean();

    return Response.json({ success: true, deals, total: deals.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
