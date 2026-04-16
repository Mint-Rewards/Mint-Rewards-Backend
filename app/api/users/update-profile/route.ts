import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { UserModel } from "@/lib/models";

export async function PUT(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const {
      userName,
      phone,
      address,
      latitude,
      longitude,
      province,
      city,
      town,
      firstTimeLogin,
    } = body;

    const updateData: Record<string, unknown> = {};

    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (userName !== undefined) updateData.userName = userName;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (province !== undefined) updateData.province = province;
    if (city !== undefined) updateData.city = city;
    if (town !== undefined) updateData.town = town;
    if (firstTimeLogin !== undefined)
      updateData.firstTimeLogin = firstTimeLogin;

    const updatedUser = await UserModel.findByIdAndUpdate(userId, updateData, {
      new: true,
    });

    if (!updatedUser) {
      return Response.json(
        { message: "User profile not found." },
        { status: 404 },
      );
    }

    return Response.json(updatedUser);
  } catch (error) {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
