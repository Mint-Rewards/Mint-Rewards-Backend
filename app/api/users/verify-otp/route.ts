import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    const body = await req.json();
    const { email, otp } = body;

    if (!email) {
      return Response.json(
        { error: "You must enter an email." },
        { status: 404 },
      );
    }

    if (!otp) {
      return Response.json({ error: "OTP value required." }, { status: 404 });
    }

    const normalizedEmail =
      typeof email === "string" ? email.toLowerCase() : "";
    const existingUser = await UserModel.findOne({ email: normalizedEmail });

    if (!existingUser) {
      return Response.json(
        { error: "User not found with given email." },
        { status: 404 },
      );
    }

    if (existingUser.otpVerification !== String(otp)) {
      return Response.json(false, { status: 400 });
    }

    return Response.json(true);
  } catch (error) {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
