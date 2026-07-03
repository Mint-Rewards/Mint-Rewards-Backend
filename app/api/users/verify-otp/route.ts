import crypto from "crypto";
import jwt from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.NEXT_JWT_SECRET;
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

    if (!JWT_SECRET) {
      return Response.json(
        { error: "Server JWT configuration is missing." },
        { status: 500 },
      );
    }

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

    const submittedHash = crypto
      .createHash("sha256")
      .update(String(otp))
      .digest();
    const storedHash = Buffer.from(reset.otpHash, "hex");
    const matches =
      submittedHash.length === storedHash.length &&
      crypto.timingSafeEqual(submittedHash, storedHash);

    if (!matches) {
      reset.attempts = (reset.attempts ?? 0) + 1;
      user.markModified("passwordReset");
      await user.save();
      return genericFailure();
    }

    // Single use: burn the OTP the moment it verifies.
    user.passwordReset = undefined;
    await user.save();

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
