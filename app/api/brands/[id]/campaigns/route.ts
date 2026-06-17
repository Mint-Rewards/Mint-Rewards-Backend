import { type NextRequest } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel } from "@/lib/models";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const { id } = await params;

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
    await connectToDatabase();

    const { id } = await params;

    const brand = await BrandModel.findById(id).lean();
    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

    // if (brand.status !== "APPROVED") {
    //   return Response.json(
    //     { success: false, message: "Only approved brands can create campaigns" },
    //     { status: 403 },
    //   );
    // }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { success: false, message: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const { name, startDate, endDate } = body;

    if (!name || typeof name !== "string" || name.trim() === "") {
      return Response.json(
        { success: false, message: "name is required" },
        { status: 400 },
      );
    }
    if (!startDate || typeof startDate !== "string") {
      return Response.json(
        { success: false, message: "startDate is required" },
        { status: 400 },
      );
    }
    if (!endDate || typeof endDate !== "string") {
      return Response.json(
        { success: false, message: "endDate is required" },
        { status: 400 },
      );
    }
    if (new Date(endDate) <= new Date(startDate)) {
      return Response.json(
        { success: false, message: "endDate must be after startDate" },
        { status: 400 },
      );
    }

    const campaign = await CampaignModel.create({
      name: name.trim(),
      startDate,
      endDate,
      brand: id,
      brandRegistration: brand.registrationNumber,
      status: "PENDING",
      ...(typeof body.description === "string" && { description: body.description }),
      ...(typeof body.campaignType === "string" && { campaignType: body.campaignType }),
      ...(typeof body.targetAudience === "string" && { targetAudience: body.targetAudience }),
      ...(typeof body.budget === "number" && { budget: body.budget }),
      ...(typeof body.backgroundColor === "string" && { backgroundColor: body.backgroundColor }),
      ...(typeof body.badge === "string" && { badge: body.badge }),
      ...(typeof body.subtitle === "string" && { subtitle: body.subtitle }),
    });

    return Response.json({ success: true, campaign }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
