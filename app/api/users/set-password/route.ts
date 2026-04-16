import bcrypt from "bcryptjs";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    const body = await req.json();
    const { email, password } = body;

    if (!password) {
      return Response.json(
        { error: "You must enter a new password." },
        { status: 400 },
      );
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const normalizedEmail =
      typeof email === "string" ? email.toLowerCase() : "";
    const user = await UserModel.findOne({ email: normalizedEmail });

    if (!user) {
      return Response.json(
        { error: "User not found with given email." },
        { status: 404 },
      );
    }

    user.password = hashedPassword;
    user.otpVerification = null;
    await user.save();

    return Response.json({
      success: true,
      message: "Password successfully updated.",
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
