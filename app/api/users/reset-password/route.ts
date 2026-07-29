import { after } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import sendPasswordResetEmail from "@/emailServices/paswordReset";
import { generateOtp, hashOtp } from "@/lib/otp";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_THROTTLE_MS = 60 * 1000;

// Truthful on every path that reaches it: the account exists and a code has
// either just been sent or was sent within the resend-throttle window. This is
// no longer an anti-enumeration hedge — unknown emails now get a 404 below.
const GENERIC_RESPONSE = {
  message: "A reset code has been sent.",
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

    // ORDERING IS LOAD-BEARING: both rate-limit checks must stay ahead of the
    // findOne below. This route discloses whether an account exists (404
    // ACCOUNT_NOT_FOUND), so these limits are the only thing throttling that
    // disclosure. Moving the existence check above them makes enumeration free.
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
      return Response.json(
        // `code` is part of the client contract, not decoration: the client
        // requires status 404 AND this code before it tells the user no account
        // exists, so a route-missing 404 falls through to a generic error.
        { error: "No account found for that email.", code: "ACCOUNT_NOT_FOUND" },
        { status: 404 },
      );
    }

    const lastSentAt = user.passwordReset?.lastSentAt;
    if (lastSentAt && Date.now() - lastSentAt.getTime() < RESEND_THROTTLE_MS) {
      return Response.json(GENERIC_RESPONSE);
    }

    const otp = generateOtp();

    user.passwordReset = {
      otpHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      lastSentAt: new Date(),
    };
    await user.save();

    const recipientEmail = user.email;
    // Deferred purely so the response doesn't wait on the mail provider. This
    // no longer equalizes response timing between existing and unknown accounts
    // — the 404 above discloses that outright.
    after(async () => {
      try {
        await sendPasswordResetEmail(recipientEmail, otp);
      } catch (emailError) {
        console.error("Failed to send password reset email:", emailError);
      }
    });

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
