import jwt from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import { verifyOtp } from "@/lib/otp";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";
import { serverEnv, logPrefix } from "@/lib/env";

const JWT_SECRET = serverEnv.jwtSecret;
const MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL = "10m";

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

    const ipLimit = await checkRateLimit("otp:ip", clientIp(req), 15, 15 * 60 * 1000);
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const normalizedEmail = email.toLowerCase().trim();
    const emailLimit = await checkRateLimit(
      "otp:email",
      hashKey(normalizedEmail),
      5,
      15 * 60 * 1000,
    );
    if (emailLimit.limited) return rateLimitResponse(emailLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await UserModel.findOne({ email: normalizedEmail }).select(
      "+passwordReset",
    );

    const reset = user?.passwordReset;
    if (
      !user ||
      !reset?.otpHash ||
      !reset.expiresAt ||
      reset.expiresAt.getTime() < Date.now()
    ) {
      return genericFailure();
    }

    if ((reset.attempts ?? 0) >= MAX_ATTEMPTS) {
      user.passwordReset = undefined;
      await user.save();
      return Response.json(
        { error: "Too many attempts. Request a new code." },
        { status: 429 },
      );
    }

    const matches = verifyOtp(String(otp), reset.otpHash);

    if (!matches) {
      // Atomic $inc guarded by the OTP hash we just read, so parallel wrong
      // guesses can't race each other into under-counting attempts, and a
      // concurrent resend/consume can't have its state clobbered.
      await UserModel.updateOne(
        { _id: user._id, "passwordReset.otpHash": reset.otpHash },
        { $inc: { "passwordReset.attempts": 1 } },
      );
      return genericFailure();
    }

    // Single use: burn the OTP the moment it verifies, but only if it's
    // still the OTP we just checked — guards against a concurrent request
    // already having consumed or rotated it.
    const consumed = await UserModel.findOneAndUpdate(
      { _id: user._id, "passwordReset.otpHash": reset.otpHash },
      { $unset: { passwordReset: "" } },
    );
    if (!consumed) {
      return genericFailure();
    }

    const resetToken = jwt.sign(
      { sub: user.id, purpose: "pwreset" },
      JWT_SECRET,
      { expiresIn: RESET_TOKEN_TTL },
    );

    return Response.json({ success: true, resetToken });
  } catch (error) {
    console.error("verify-otp error:", error);
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
