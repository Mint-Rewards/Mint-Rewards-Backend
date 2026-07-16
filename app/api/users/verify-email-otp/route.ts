import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
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
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
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

    if (!JWT_SECRET) {
      return Response.json(
        { error: "Server JWT configuration is missing." },
        { status: 500 },
      );
    }

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

    const submittedHash = crypto
      .createHash("sha256")
      .update(String(otp))
      .digest();
    const storedHash = Buffer.from(verification.otpHash, "hex");
    const matches =
      submittedHash.length === storedHash.length &&
      crypto.timingSafeEqual(submittedHash, storedHash);

    if (!matches) {
      verification.attempts = (verification.attempts ?? 0) + 1;
      user.markModified("emailVerification");
      await user.save();
      return genericFailure();
    }

    // Single use: burn the OTP the moment it verifies.
    user.emailVerification = undefined;
    user.emailVerified = true;
    await user.save();

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
