import crypto from "crypto";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import sendPasswordResetEmail from "@/emailServices/paswordReset";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_THROTTLE_MS = 60 * 1000;

// Identical response whether or not the email exists — prevents enumeration.
const GENERIC_RESPONSE = {
  message: "If an account exists for that email, a reset code has been sent.",
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = body.email;

    if (!email || typeof email !== "string") {
      return Response.json(
        { error: "You must enter an email." },
        { status: 400 },
      );
    }

    const ipLimit = await checkRateLimit("reset:ip", clientIp(req), 5, 15 * 60 * 1000);
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const normalizedEmail = email.toLowerCase().trim();
    const emailLimit = await checkRateLimit(
      "reset:email",
      hashKey(normalizedEmail),
      3,
      60 * 60 * 1000,
    );
    if (emailLimit.limited) return rateLimitResponse(emailLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await UserModel.findOne({ email: normalizedEmail }).select(
      "+passwordReset",
    );

    if (!user) {
      return Response.json(GENERIC_RESPONSE);
    }

    const lastSentAt = user.passwordReset?.lastSentAt;
    if (lastSentAt && Date.now() - lastSentAt.getTime() < RESEND_THROTTLE_MS) {
      return Response.json(GENERIC_RESPONSE);
    }

    const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

    user.passwordReset = {
      otpHash: crypto.createHash("sha256").update(otp).digest("hex"),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      lastSentAt: new Date(),
    };
    await user.save();

    try {
      await sendPasswordResetEmail(user.email, otp);
    } catch (emailError) {
      console.error("Failed to send password reset email:", emailError);
    }

    return Response.json(GENERIC_RESPONSE);
  } catch (error) {
    console.error("reset-password error:", error);
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
