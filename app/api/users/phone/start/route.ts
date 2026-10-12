/**
 * Asking for a one-time code on a phone number.
 *
 * Two intents through one door, and the difference is the point: signing in
 * must not sign anybody up. The same rule was applied to Google and Apple,
 * for the same reason — a button that says "sign in" creating an account is
 * how somebody ends up with a second one without noticing.
 *
 * See docs/specs/phone-and-whatsapp-signup.md.
 */
import { NextResponse } from "next/server";
import { after } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import {
  createUser,
  findUserByPhone,
  findUserByPhoneWithOtp,
  setUserOtp,
  addPoints,
} from "@/lib/repositories/users";
import { inTransaction } from "@/lib/repositories/brandhub";
import { generateOtp } from "@/lib/otp";
import { normalizePhone, PHONE_PROBLEM_TEXT } from "@/lib/phoneNumber";
import { phoneOtpBlock, resentTooSoon } from "@/lib/phoneAuth";
import { otpSender } from "@/whatsappServices/otpSender";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string;
      intent?: string;
    };

    const parsed = normalizePhone(body.phone);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: PHONE_PROBLEM_TEXT[parsed.problem], code: parsed.problem },
        { status: 400 },
      );
    }
    const intent = body.intent === "signin" ? "signin" : "signup";
    const { e164 } = parsed;

    /*
     * Both keys, because they stop different things.
     *
     * Per IP stops one machine working through a list of numbers. Per number
     * stops somebody using our send button to pester a phone that is not
     * theirs — and every one of those messages is billed to us.
     */
    const ipLimit = await checkRateLimit("phone:ip", clientIp(req), 20, 60 * 60 * 1000);
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const numberLimit = await checkRateLimit("phone:number", hashKey(e164), 5, 60 * 60 * 1000);
    if (numberLimit.limited) return rateLimitResponse(numberLimit.retryAfterSeconds);

    await connectToDatabase();

    const verified = await findUserByPhone(e164);

    if (intent === "signin" && !verified) {
      /*
       * An unknown number does not quietly become an account.
       *
       * The client shows the signup screen on this code. Saying so plainly
       * rather than generically is a deliberate trade: it confirms the number
       * has no account, and the alternative — silence — strands somebody at a
       * screen that never progresses, which is the worse outcome for a flow
       * whose entire purpose is to stop losing households.
       */
      return NextResponse.json(
        { error: "No account uses that number yet.", code: "ACCOUNT_NOT_FOUND" },
        { status: 404 },
      );
    }

    if (intent === "signup" && verified) {
      // Signing up onto an account that already exists is signing in.
      return NextResponse.json(
        { error: "That number already has an account. Sign in instead.", code: "ACCOUNT_EXISTS" },
        { status: 409 },
      );
    }

    /*
     * The row the code belongs to.
     *
     * For sign-in it is the verified account. For signup it is a pending row
     * — created unverified, exactly as email signup creates a row before the
     * address is confirmed. A row with phone_e164 set and phone_verified_at
     * null can only have come from this flow, because no legacy account has
     * ever had phone_e164 written, so reusing it on a resend cannot collide
     * with anybody's real account.
     */
    const pending = verified ?? (await findUserByPhoneWithOtp(e164));

    if (pending && resentTooSoon(await currentOtp(e164))) {
      /*
       * Not an error. The code already on its way is still good, and saying
       * "wait" to somebody who tapped twice is worse than letting the first
       * message do its job.
       */
      return NextResponse.json({ success: true, sent: false, reason: "ALREADY_SENT" });
    }

    const code = generateOtp();
    let userId: string;

    if (pending) {
      userId = pending._id;
      await setUserOtp(userId, "phoneVerification", phoneOtpBlock(code));
    } else {
      userId = await inTransaction(async (tx) => {
        const created = await createUser(
          {
            userName: "",
            // No address: that is the whole point of this route. The CHECK
            // added in 0011 is satisfied by the number.
            email: null,
            phone: parsed.national,
            phoneE164: e164,
          },
          tx,
        );
        /*
         * The same hundred points email signup grants, at the same moment —
         * before verification. Mirrored deliberately: two signup paths that
         * pay differently is a difference somebody has to explain, and the
         * account is unusable until the code is answered either way.
         */
        await addPoints(created._id, 100, tx);
        await setUserOtp(created._id, "phoneVerification", phoneOtpBlock(code), tx);
        return created._id;
      });
    }

    /*
     * Deferred, so the response does not wait on WhatsApp.
     *
     * A failure here is logged rather than returned: the row and the code are
     * already stored, so the person can ask for a resend, and surfacing a
     * provider error would tell them to fix something they cannot.
     */
    after(async () => {
      const result = await otpSender().send(e164, code);
      if (!result.ok) {
        console.error(
          `[phone] could not send to ${e164}: ${result.error} (retryable=${result.retryable})`,
        );
      }
    });

    return NextResponse.json({ success: true, sent: true, userId });
  } catch (error) {
    console.error("phone/start error:", error);
    return NextResponse.json(
      { error: "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}

/** The stored block for a number, for the resend throttle. */
async function currentOtp(e164: string) {
  const row = await findUserByPhoneWithOtp(e164);
  return row?.otp ?? null;
}
