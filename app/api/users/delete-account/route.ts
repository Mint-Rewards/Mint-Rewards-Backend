import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { deleteUser } from "@/lib/repositories/users";

export async function DELETE(req: Request) {
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

    const deleted = await deleteUser(String(userId));

    if (!deleted) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    return Response.json({
      message: "Account deleted successfully",
    });
  } catch {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
