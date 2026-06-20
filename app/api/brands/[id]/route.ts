import { NextResponse, type NextRequest } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";

interface RouteParams {
  params: Promise<{
    id: string;
  }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const { id } = await params;

    const brand = await BrandModel.findById(id);

    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, brand });
  } catch (error: any) {
    return Response.json(
      {
        success: false,
        message: "Server error",
        error: error?.message || "Unexpected error",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams
) {
  // Temporary admin guardard - replace with proper auth in the future
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { status, reason } = await req.json();

  const validStatuses = ["APPROVED", "REJECTED"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { success: false, error: `status must be one of: ${validStatuses.join(", ")}` },
      { status: 400 }
    );
  }

  await connectToDatabase();

  const update: Record<string, unknown> = { status };
  if (reason) update.rejectionReason = reason;

  const brand = await BrandModel.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true, runValidators: true }
  ).select("-password -verificationToken");

  if (!brand) {
    return NextResponse.json({ success: false, error: "Brand not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, brand }, { status: 200 });
}