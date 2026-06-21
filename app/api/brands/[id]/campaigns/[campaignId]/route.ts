import { type NextRequest } from "next/server";
import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import { CampaignModel } from "@/lib/models";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? process.env.VITE_ADMIN_SECRET;
const MAX_BANNER_BYTES = 5 * 1024 * 1024; // 5 MB

interface RouteParams {
  params: Promise<{ id: string; campaignId: string }>;
}

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

const ADMIN_ONLY = new Set(["status"]);

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const { id, campaignId } = await params;

    const authHeader = req.headers.get("Authorization") ?? "";
    const isAdmin = ADMIN_SECRET && authHeader === `Bearer ${ADMIN_SECRET}`;

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
          `campaigns/${id}/banner-${Date.now()}${ext}`,
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
      if (ADMIN_ONLY.has(key)) {
        if (!isAdmin) {
          return Response.json(
            { success: false, message: "Unauthorized: admin access required to change status" },
            { status: 403 },
          );
        }
        update[key] = typeof value === "string" ? value.toUpperCase() : value;
      } else if (BRAND_EDITABLE.has(key) && value !== undefined && value !== null) {
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
      { _id: campaignId, brand: id },
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

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const { id, campaignId } = await params;

    const campaign = await CampaignModel.findOneAndDelete({
      _id: campaignId,
      brand: id,
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
