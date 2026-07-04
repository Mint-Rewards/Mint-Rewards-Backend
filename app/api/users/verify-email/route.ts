import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";

export async function GET(req: Request) {
  try {
    await connectToDatabase();

    const { searchParams } = new URL(req.url);
    const token = searchParams.get("token");

    if (!token) {
      return Response.json(
        { error: "Verification token is required." },
        { status: 400 },
      );
    }

    const user = await UserModel.findOne({ verificationToken: token });

    if (!user) {
      return Response.json(
        { error: "Invalid or expired verification link." },
        { status: 400 },
      );
    }

    user.emailVerified = true;
    user.verificationToken = undefined;
    await user.save();

    return Response.json({
      success: true,
      message: "Email verified successfully.",
    });
  } catch (error) {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
