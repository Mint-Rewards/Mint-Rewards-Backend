/**
 * Answering the code, and being signed in.
 *
 * One endpoint for both intents, because at this point they are the same act:
 * the number is proved, and whichever row holds it becomes a session. Which
 * of the two it was is already settled by /phone/start, which refuses to
 * create an account for a sign-in and refuses to sign in to one that does not
 * exist.
 *
 * See docs/specs/phone-and-whatsapp-signup.md.
 */
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import {
  countUsers,
  findUserByPhoneWithOtp,
  markPhoneVerified,
  recordOtpAttempt,
} from "@/lib/repositories/users";
import { hashOtp } from "@/lib/otp";
import { normalizePhone, PHONE_PROBLEM_TEXT } from "@/lib/phoneNumber";
import { otpProblem } from "@/lib/phoneAuth";
import { checkRateLimit, clientIp, hashKey, rateLimitResponse } from "@/lib/rateLimit";
import { serverEnv } from "@/lib/env";

const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;

/**
 * One message for every way a code can fail.
 *
 * Guessing which of "wrong", "expired" or "never sent" applies is how an
 * attacker learns whether a number has a pending signup. The person who
 * genuinely mistyped is told to ask for another, which is the action in
 * every case anyway.
 */
const WRONG = { error: "That code is not right, or it has expired. Ask for a new one." };

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string;
      otp?: string;
    };

    const parsed = normalizePhone(body.phone);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: PHONE_PROBLEM_TEXT[parsed.problem], code: parsed.problem },
        { status: 400 },
      );
    }
    const supplied = String(body.otp ?? "").trim();
    const { e164 } = parsed;

    /*
     * Rate limited on the number as well as the IP.
     *
     * Six digits is a million guesses, and the per-code attempt counter only
     * protects one code — rotating through resends would otherwise give an
     * attacker as many five-guess windows as they cared to request.
     */
    const ipLimit = await checkRateLimit("phoneVerify:ip", clientIp(req), 30, 60 * 60 * 1000);
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const numberLimit = await checkRateLimit(
      "phoneVerify:number",
      hashKey(e164),
      15,
      60 * 60 * 1000,
    );
    if (numberLimit.limited) return rateLimitResponse(numberLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await findUserByPhoneWithOtp(e164);
    if (!user) return NextResponse.json(WRONG, { status: 400 });

    if (otpProblem(user.otp)) return NextResponse.json(WRONG, { status: 400 });

    const storedHash = user.otp!.otpHash!;
    if (hashOtp(supplied) !== storedHash) {
      /*
       * Counted against the exact code that was read, so a concurrent resend
       * cannot have its new code's counter bumped by a guess at the old one.
       */
      await recordOtpAttempt(user._id, "phoneVerification", storedHash);
      return NextResponse.json(WRONG, { status: 400 });
    }

    /*
     * Marked and burned in one statement, guarded on the hash.
     *
     * Returns false if a concurrent request got there first, or if the unique
     * index refused because somebody else has already proved this number. A
     * retry cannot win either race, so this is not retried.
     */
    const verified = await markPhoneVerified(user._id, storedHash);
    if (!verified) {
      return NextResponse.json(
        { error: "That number has just been verified elsewhere. Try signing in." },
        { status: 409 },
      );
    }

    const token = jwt.sign({ id: user._id }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    /*
     * `isNewAccount` tells the client whether to send this person to profile
     * completion or to the home screen. A phone signup starts with no name
     * and no address, so dropping them on a home screen that says "welcome,"
     * with a blank where their name goes is the wrong first impression — and
     * they cannot be collected from until they finish anyway.
     */
    const isNewAccount = !user.userName?.trim();

    return NextResponse.json({
      success: true,
      token: `Bearer ${token}`,
      user: { ...user, otp: undefined },
      isNewAccount,
      users: await countUsers(),
    });
  } catch (error) {
    console.error("phone/verify error:", error);
    return NextResponse.json(
      { error: "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}
