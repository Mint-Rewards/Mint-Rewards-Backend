import { type NextRequest } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { DealModel } from "@/lib/models";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface RouteParams {
  params: Promise<{ id: string; dealId: string }>;
}

const ALLOWED_FIELDS = new Set([
  "title",
  "description",
  "discountPercentage",
  "discountAmount",
  "promoCode",
  "startDate",
  "endDate",
  "maxUses",
  "minimumPurchase",
  "status",
]);

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const { id, dealId } = await params;

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { success: false, message: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_FIELDS.has(key) && value !== undefined) {
        update[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    if (Object.keys(update).length === 0) {
      return Response.json(
        { success: false, message: "No valid fields provided" },
        { status: 400 },
      );
    }

    const deal = await DealModel.findOneAndUpdate(
      { _id: dealId, brand: id },
      { $set: update },
      { new: true, runValidators: true },
    );

    if (!deal) {
      return Response.json(
        { success: false, message: "Deal not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, deal });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const { id, dealId } = await params;

    const deal = await DealModel.findOneAndDelete({ _id: dealId, brand: id });

    if (!deal) {
      return Response.json(
        { success: false, message: "Deal not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, message: "Deal deleted" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
