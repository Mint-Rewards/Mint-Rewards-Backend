import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel } from "@/lib/models";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";
import {
  cleanSuppliedCodes,
  parseSuppliedCodes as parseDiscountCodes,
} from "@/lib/dealCodes";

const MAX_BANNER_BYTES = 5 * 1024 * 1024; // 5 MB

/** Multipart sends booleans as "true"/"false" strings. */
function parseBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

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

    const campaigns = await CampaignModel.find({ brand: brandId })
      .sort({ _id: -1 })
      .lean();

    return Response.json({ success: true, campaigns, total: campaigns.length });
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

    const brand = await BrandModel.findById(brandId).lean();
    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

    const contentType = req.headers.get("content-type") ?? "";
    let body: Record<string, unknown> = {};
    let bannerUrl = "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      for (const [key, value] of formData.entries()) {
        if (key !== "banner") body[key] = value;
      }

      const bannerFile = formData.get("banner");
      if (bannerFile instanceof File && bannerFile.size > 0) {
        if (!bannerFile.type.startsWith("image/")) {
          return Response.json(
            { success: false, message: "Banner must be an image file" },
            { status: 400 },
          );
        }
        if (bannerFile.size > MAX_BANNER_BYTES) {
          return Response.json(
            { success: false, message: "Banner must be under 5 MB" },
            { status: 400 },
          );
        }
        const ext = bannerFile.name.includes(".")
          ? `.${bannerFile.name.split(".").pop()?.toLowerCase()}`
          : "";
        const blob = await put(
          `campaigns/${brandId}/banner-${Date.now()}${ext}`,
          Buffer.from(await bannerFile.arrayBuffer()),
          {
            access: "public",
            contentType: bannerFile.type || "image/jpeg",
            token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
          },
        );
        bannerUrl = blob.url;
      }
    } else {
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { success: false, message: "Invalid request body" },
          { status: 400 },
        );
      }
    }

    const { name, startDate, endDate } = body;

    if (!name || typeof name !== "string" || (name as string).trim() === "") {
      return Response.json(
        { success: false, message: "name is required" },
        { status: 400 },
      );
    }

    // A campaign with no discountCodes is a dead coupon in the app: redeem
    // rejects it with 409 "no discount codes available" and it renders a blank
    // discount badge. There is no endpoint to attach codes after the fact, so
    // require them here rather than let an unredeemable campaign be created.
    const codeResult = cleanSuppliedCodes(parseDiscountCodes(body.discountCodes));
    if ("error" in codeResult) {
      return Response.json(
        { success: false, message: codeResult.error },
        { status: 400 },
      );
    }
    const isSingleCode = parseBoolean(body.isSingleCode);

    // Per-user codes hand each redeemer a distinct code from the pool, so the
    // pool size is the redemption cap; a single shared code has no such limit.
    if (!isSingleCode && codeResult.codes.length < 2) {
      return Response.json(
        {
          success: false,
          message:
            "Provide more than one code, or set isSingleCode to share one code with every user",
        },
        { status: 400 },
      );
    }

    // Schema stores discountPercentage as a string; accept either form.
    const rawPercentage = body.discountPercentage;
    const discountPercentage =
      typeof rawPercentage === "number"
        ? String(rawPercentage)
        : typeof rawPercentage === "string" && rawPercentage.trim() !== ""
          ? rawPercentage.trim()
          : "";

    const campaign = await CampaignModel.create({
      discountCodes: codeResult.codes,
      isSingleCode,
      ...(discountPercentage && { discountPercentage }),
      name: (name as string).trim(),
      ...(typeof startDate === "string" && startDate && { startDate }),
      ...(typeof endDate === "string" && endDate && { endDate }),
      brand: brandId,
      brandRegistration: brand.registrationNumber,
      status: "PENDING",
      ...(typeof body.description === "string" && { description: body.description }),
      ...(typeof body.campaignType === "string" && { campaignType: body.campaignType }),
      ...(typeof body.targetAudience === "string" && { targetAudience: body.targetAudience }),
      ...(typeof body.budget === "number" && { budget: body.budget }),
      ...(body.budget && !Number.isNaN(Number(body.budget)) && typeof body.budget !== "number"
        ? { budget: Number(body.budget) }
        : {}),
      ...(typeof body.backgroundColor === "string" && { backgroundColor: body.backgroundColor }),
      ...(typeof body.badge === "string" && { badge: body.badge }),
      ...(typeof body.subtitle === "string" && { subtitle: body.subtitle }),
      ...(bannerUrl && { banner: bannerUrl }),
    });

    return Response.json({ success: true, campaign }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
