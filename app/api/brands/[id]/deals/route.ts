import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, DealModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";
import { requireAdminAuth } from "@/lib/requireAdminAuth";
import { cleanSuppliedCodes, generateDealCodes } from "@/lib/dealCodes";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const auth = requireBrandAuth(req);
    if (auth instanceof NextResponse) return auth;

    const scope = await requireBrandScope(auth.brandUser, id);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const brand = await BrandModel.findById(id).lean();
    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

    const deals = await DealModel.find({ brand: id }).sort({ _id: -1 }).lean();

    return Response.json({ success: true, deals, total: deals.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Admins create deals on behalf of any brand from the admin dashboard,
    // without holding that brand's org credentials; everyone else must own
    // the brand. Same bypass shape as the PATCH routes.
    const isAdmin = !(requireAdminAuth(req) instanceof NextResponse);
    if (!isAdmin) {
      const auth = requireBrandAuth(req);
      if (auth instanceof NextResponse) return auth;

      const scope = await requireBrandScope(auth.brandUser, id);
      if (scope instanceof NextResponse) return scope;
    }

    await connectToDatabase();

    const brand = await BrandModel.findById(id).lean();
    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

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

    // Code inventory. Callers that supply neither `codes` nor `generateCodes`
    // keep the old codeless behaviour (existing legacy clients); anything that
    // supplies one goes through the same cleaning/generation as the BrandHub
    // route, and gets maxUses derived rather than client-supplied.
    const hasSupplied = body.codes !== undefined;
    const hasGenerate = body.generateCodes !== undefined;

    let codes: string[] | null = null;
    if (hasSupplied || hasGenerate) {
      if (hasSupplied && hasGenerate) {
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
      codes = codeResult.codes;
    }

    // Brand-created deals go through admin review. An admin creating a deal IS
    // the reviewer, so theirs go live immediately; an explicit status in the
    // body still wins, and only an admin may set one.
    const DEAL_STATUSES = [
      "pending",
      "active",
      "rejected",
      "inactive",
      "expired",
    ] as const;
    type DealStatus = (typeof DEAL_STATUSES)[number];

    const isDealStatus = (value: unknown): value is DealStatus =>
      typeof value === "string" &&
      (DEAL_STATUSES as readonly string[]).includes(value);

    if (body.status !== undefined && !isAdmin) {
      return Response.json(
        { success: false, message: "status is admin-only" },
        { status: 403 },
      );
    }
    if (body.status !== undefined && !isDealStatus(body.status)) {
      return Response.json(
        {
          success: false,
          message: `status must be one of: ${DEAL_STATUSES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    const status: DealStatus = isDealStatus(body.status)
      ? body.status
      : isAdmin
        ? "active"
        : "pending";

    const deal = await DealModel.create({
      brand: id,
      title: title.trim(),
      status,
      ...(codes && {
        codes,
        // Legacy readers (admin/mobile) expect the single promoCode field.
        promoCode: codes[0],
        // Derived, never taken from the client: one code is redeemable exactly
        // once by one user, so maxUses IS the code count (issue #44).
        maxUses: codes.length,
      }),
      ...(typeof body.description === "string" && { description: body.description }),
      ...(typeof body.discountPercentage === "number" && { discountPercentage: body.discountPercentage }),
      ...(typeof body.discountAmount === "number" && { discountAmount: body.discountAmount }),
      ...(!codes &&
        typeof body.promoCode === "string" &&
        body.promoCode && { promoCode: body.promoCode }),
      ...(typeof body.startDate === "string" && body.startDate && { startDate: body.startDate }),
      ...(typeof body.endDate === "string" && body.endDate && { endDate: body.endDate }),
      ...(!codes && typeof body.maxUses === "number" && { maxUses: body.maxUses }),
      ...(typeof body.minimumPurchase === "number" && { minimumPurchase: body.minimumPurchase }),
    });

    return Response.json({ success: true, deal }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
