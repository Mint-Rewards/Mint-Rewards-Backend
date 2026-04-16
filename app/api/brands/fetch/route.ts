import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";

export async function GET() {
  try {
    await connectToDatabase();

    const brands = await BrandModel.find({
      status: "PENDING",
    }).sort({ _id: -1 });

    return Response.json({ success: true, brands });
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
