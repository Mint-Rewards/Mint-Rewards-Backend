import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { DealModel } from "@/lib/models";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";
import { cleanSuppliedCodes, generateDealCodes } from "@/lib/dealCodes";

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const access = await requireModuleAccess(req, "consumer-reporting", "read");
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const deals = await DealModel.find({ brand: brandId })
      .sort({ _id: -1 })
      .lean();

    const withCounts = deals.map((d) => ({
      ...d,
      codes: d.codes ?? [],
      codeCount: d.codes?.length ?? 0,
    }));

    return Response.json({
      success: true,
      deals: withCounts,
      total: withCounts.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const access = await requireModuleAccess(
      req,
      "consumer-reporting",
      "write",
    );
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { success: false, message: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const { title } = body;
    if (!title || typeof title !== "string" || title.trim() === "") {
      return Response.json(
        { success: false, message: "title is required" },
        { status: 400 },
      );
    }

    // Exactly one code source: brand-supplied `codes` or server `generateCodes`.
    const hasSupplied = body.codes !== undefined;
    const hasGenerate = body.generateCodes !== undefined;
    if (hasSupplied === hasGenerate) {
      return Response.json(
        {
          success: false,
          message:
            "Provide exactly one of codes (string[]) or generateCodes ({ count, prefix? })",
        },
        { status: 400 },
      );
    }
    const codeResult = hasSupplied
      ? cleanSuppliedCodes(body.codes)
      : generateDealCodes(body.generateCodes);
    if ("error" in codeResult) {
      return Response.json(
        { success: false, message: codeResult.error },
        { status: 400 },
      );
    }
    const codes = codeResult.codes;

    const deal = await DealModel.create({
      brand: brandId,
      title: title.trim(),
      codes,
      // Legacy readers (admin/mobile) expect the single promoCode field.
      promoCode: codes[0],
      status: "pending",
      ...(typeof body.description === "string" && { description: body.description }),
      ...(typeof body.discountPercentage === "number" && { discountPercentage: body.discountPercentage }),
      ...(typeof body.discountAmount === "number" && { discountAmount: body.discountAmount }),
      ...(typeof body.startDate === "string" && body.startDate && { startDate: body.startDate }),
      ...(typeof body.endDate === "string" && body.endDate && { endDate: body.endDate }),
      // Derived, never taken from the client: one code is redeemable exactly
      // once by one user, so maxUses IS the code count (issue #44).
      maxUses: codes.length,
      ...(typeof body.minimumPurchase === "number" && { minimumPurchase: body.minimumPurchase }),
    });

    return Response.json({ success: true, deal }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
