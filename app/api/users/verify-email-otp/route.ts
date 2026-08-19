import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import { verifyOtp } from "@/lib/otp";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";
import { serverEnv } from "@/lib/env";
import { awardReferralIfApplicable } from "@/lib/referrals";

const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;
const MAX_ATTEMPTS = 5;

// One indistinguishable failure for missing user / expired / wrong code.
function genericFailure() {
  return Response.json({ error: "Invalid or expired code." }, { status: 400 });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email, otp } = body;

    if (!email || typeof email !== "string" || !otp) {
      return Response.json(
        { error: "Email and OTP are required." },
        { status: 400 },
      );
    }

    const ipLimit = await checkRateLimit(
      "verifyemail:ip",
      clientIp(req),
      15,
      15 * 60 * 1000,
    );
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const normalizedEmail = email.toLowerCase().trim();
    const emailLimit = await checkRateLimit(
      "verifyemail:email",
      hashKey(normalizedEmail),
      5,
      15 * 60 * 1000,
    );
    if (emailLimit.limited) return rateLimitResponse(emailLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await UserModel.findOne({ email: normalizedEmail }).select(
      "+emailVerification",
    );

    const verification = user?.emailVerification;
    if (
      !user ||
      !verification?.otpHash ||
      !verification.expiresAt ||
      verification.expiresAt.getTime() < Date.now()
    ) {
      return genericFailure();
    }

    if ((verification.attempts ?? 0) >= MAX_ATTEMPTS) {
      user.emailVerification = undefined;
      await user.save();
      return Response.json(
        { error: "Too many attempts. Request a new code." },
        { status: 429 },
      );
    }

    const matches = verifyOtp(String(otp), verification.otpHash);

    if (!matches) {
      // Atomic $inc guarded by the OTP hash we just read, so parallel wrong
      // guesses can't race each other into under-counting attempts, and a
      // concurrent resend/consume can't have its state clobbered.
      await UserModel.updateOne(
        { _id: user._id, "emailVerification.otpHash": verification.otpHash },
        { $inc: { "emailVerification.attempts": 1 } },
      );
      return genericFailure();
    }

    // Single use: burn the OTP the moment it verifies, but only if it's
    // still the OTP we just checked — guards against a concurrent request
    // already having consumed or rotated it.
    const consumed = await UserModel.findOneAndUpdate(
      { _id: user._id, "emailVerification.otpHash": verification.otpHash },
      { $unset: { emailVerification: "" }, $set: { emailVerified: true } },
    );
    if (!consumed) {
      return genericFailure();
    }

    // The otpHash-guarded write above is the idempotency anchor: exactly one
    // request per user ever reaches here.
    await awardReferralIfApplicable(user._id, normalizedEmail);

    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    return Response.json({
      success: true,
      message: "Email verified successfully.",
      token: `Bearer ${token}`,
    });
  } catch (error) {
    console.error("verify-email-otp error:", error);
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
