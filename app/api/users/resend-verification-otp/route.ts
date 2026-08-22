import { after } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import sendSignupEmail from "@/emailServices/signupConfirmation";
import { generateOtp, hashOtp } from "@/lib/otp";
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
  message:
    "If an unverified account exists for that email, a new code has been sent.",
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

    const ipLimit = await checkRateLimit(
      "resendverify:ip",
      clientIp(req),
      5,
      15 * 60 * 1000,
    );
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const normalizedEmail = email.toLowerCase().trim();
    // 3 per 10 minutes rather than 3 per hour. These windows are tumbling and
    // epoch-aligned, so Retry-After is time-to-boundary, not a fixed penalty:
    // on an hourly window a user who spent their three resends could be told to
    // wait anything from 1 to 59 minutes depending only on where in the hour
    // they happened to be. A code that lands in spam or arrives slowly made
    // that reachable for legitimate users, not just abusers.
    const emailLimit = await checkRateLimit(
      "resendverify:email",
      hashKey(normalizedEmail),
      3,
      10 * 60 * 1000,
    );
    if (emailLimit.limited)
      return rateLimitResponse(emailLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await UserModel.findOne({ email: normalizedEmail }).select(
      "+emailVerification",
    );

    if (!user || user.emailVerified) {
      return Response.json(GENERIC_RESPONSE);
    }

    // Same generic response as the "no account" branch above — a distinct
    // status here would let callers detect a registered, unverified email by
    // firing two requests back to back.
    const lastSentAt = user.emailVerification?.lastSentAt;
    if (lastSentAt && Date.now() - lastSentAt.getTime() < RESEND_THROTTLE_MS) {
      return Response.json(GENERIC_RESPONSE);
    }

    const otp = generateOtp();

    user.emailVerification = {
      otpHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      lastSentAt: new Date(),
    };
    await user.save();

    const recipientEmail = user.email;
    // Deferred so the response returns at the same speed regardless of
    // whether an email was actually sent — keeps timing consistent with the
    // "no account" / "already verified" branches above.
    after(async () => {
      try {
        await sendSignupEmail(recipientEmail, otp);
      } catch (emailError) {
        console.error("Failed to send verification email:", emailError);
      }
    });

    return Response.json(GENERIC_RESPONSE);
  } catch (error) {
    console.error("resend-verification-otp error:", error);
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
