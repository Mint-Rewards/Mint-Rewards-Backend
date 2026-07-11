import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import { CampaignModel } from "@/lib/models";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";

const MAX_BANNER_BYTES = 5 * 1024 * 1024; // 5 MB

interface RouteParams {
  params: Promise<{ brandId: string; campaignId: string }>;
}

// Campaign status is moderation state (PENDING/APPROVED) and stays
// admin-only on the legacy moderation route — never editable here.
const BRAND_EDITABLE = new Set([
  "name",
  "description",
  "startDate",
  "endDate",
  "campaignType",
  "targetAudience",
  "budget",
  "backgroundColor",
  "badge",
  "subtitle",
  "banner",
]);

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId, campaignId } = await params;

    const access = await requireModuleAccess(
      req,
      "consumer-reporting",
      "write",
    );
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const contentType = req.headers.get("content-type") ?? "";
    let body: Record<string, unknown> = {};
    let bannerUrl: string | undefined;

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
          { success: false, message: "Invalid JSON body" },
          { status: 400 },
        );
      }
    }

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (BRAND_EDITABLE.has(key) && value !== undefined && value !== null) {
        update[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    if (bannerUrl) {
      update.banner = bannerUrl;
    }

    if (Object.keys(update).length === 0) {
      return Response.json(
        { success: false, message: "No valid fields provided" },
        { status: 400 },
      );
    }

    const campaign = await CampaignModel.findOneAndUpdate(
      { _id: campaignId, brand: brandId },
      { $set: update },
      { new: true, runValidators: true },
    );

    if (!campaign) {
      return Response.json(
        { success: false, message: "Campaign not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, campaign });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId, campaignId } = await params;

    // Hard delete with no audit trail — deliberately requires "manage".
    const access = await requireModuleAccess(
      req,
      "consumer-reporting",
      "manage",
    );
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const campaign = await CampaignModel.findOneAndDelete({
      _id: campaignId,
      brand: brandId,
    });

    if (!campaign) {
      return Response.json(
        { success: false, message: "Campaign not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, message: "Campaign deleted" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
