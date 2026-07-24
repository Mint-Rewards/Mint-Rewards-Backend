import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import sendPasswordResetEmail from "@/emailServices/paswordReset";

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    const body = await req.json();
    const email = body.email;

    if (!email) {
      return Response.json(
        { error: "You must enter an email." },
        { status: 404 },
      );
    }

    const normalizedEmail = email.toLowerCase();

    const user = await UserModel.findOne({ email: normalizedEmail });

    if (!user) {
      return Response.json(
        { error: "User not found with given email." },
        { status: 404 },
      );
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    await sendPasswordResetEmail(user.email, otp);

    user.otpVerification = otp;
    await user.save();

    return Response.json({
      message: "Please check you email for password reset otp",
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
