import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import {
  findUserByEmailWithOtp,
  markEmailVerified,
  recordOtpAttempt,
  setUserOtp,
} from "@/lib/repositories/users";
import { verifyOtp } from "@/lib/otp";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";
import { serverEnv } from "@/lib/env";

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
    if (emailLimit.limited)
      return rateLimitResponse(emailLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await findUserByEmailWithOtp(
      normalizedEmail,
      "emailVerification",
    );

    const verification = user?.otp;
    // jsonb returns the timestamp as an ISO string, not a Date.
    const expiresAt = verification?.expiresAt
      ? new Date(verification.expiresAt)
      : null;
    if (
      !user ||
      !verification?.otpHash ||
      !expiresAt ||
      expiresAt.getTime() < Date.now()
    ) {
      return genericFailure();
    }

    if ((verification.attempts ?? 0) >= MAX_ATTEMPTS) {
      await setUserOtp(user._id, "emailVerification", null);
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
      await recordOtpAttempt(
        user._id,
        "emailVerification",
        verification.otpHash,
      );
      return genericFailure();
    }

    // Single use: burn the OTP the moment it verifies, but only if it's
    // still the OTP we just checked — guards against a concurrent request
    // already having consumed or rotated it.
    const consumed = await markEmailVerified(user._id, verification.otpHash);
    if (!consumed) {
      return genericFailure();
    }

    const token = jwt.sign({ id: user._id }, JWT_SECRET, {
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
