import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";
import { serverEnv } from "@/lib/env";

const MAX_BANNER_BYTES = 5 * 1024 * 1024; // 5 MB

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

    const campaigns = await CampaignModel.find({ brand: id })
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
          `campaigns/${id}/banner-${Date.now()}${ext}`,
          Buffer.from(await bannerFile.arrayBuffer()),
          {
            access: "public",
            contentType: bannerFile.type || "image/jpeg",
            token: serverEnv.blobReadWriteToken,
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

    const campaign = await CampaignModel.create({
      name: (name as string).trim(),
      ...(typeof startDate === "string" && startDate && { startDate }),
      ...(typeof endDate === "string" && endDate && { endDate }),
      brand: id,
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
