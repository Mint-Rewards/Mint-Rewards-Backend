import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import { inTransaction } from "@/lib/repositories/brandhub";
import {
  addPoints,
  createUser,
  generateMintId,
  reviveUser,
  findUserByEmail,
  findUserByMintId,
  setUserOtp,
  updateUser,
} from "@/lib/repositories/users";
import sendSignupEmail from "@/emailServices/signupConfirmation";
import { generateOtp, hashOtp } from "@/lib/otp";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";
import { serverEnv, logPrefix } from "@/lib/env";
import { EMAIL_REGEX, MAX_EMAIL_LENGTH } from "@/lib/emailFormat";
import { validatePasswordLength } from "@/lib/password";

const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;

export async function GET() {
  return Response.json({ message: "SignUp API is alive" });
}

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    const body = await req.json();
    const {
      userName,
      password,
      confirmPassword,
      phone,
      address,
      province,
      city,
      town,
      latitude = null,
      longitude = null,
    } = body;
    const email = String(body.email || "").toLowerCase();

    if (!userName || !email || !password || !confirmPassword) {
      console.log("Missing required fields");
      return Response.json(
        { error: "All fields are required." },
        { status: 400 },
      );
    }

    // RFC 5321 caps a forward path at 254 characters. Checked before the regex
    // so an oversized string is rejected outright rather than matched against.
    if (email.length > MAX_EMAIL_LENGTH) {
      return Response.json({ error: "Invalid email format." }, { status: 400 });
    }

    // Regex and length cap moved to lib/emailFormat.ts so the referral
    // endpoint validates identically. Rule and behaviour unchanged.
    if (!EMAIL_REGEX.test(email)) {
      console.log("Invalid email format");
      return Response.json({ error: "Invalid email format." }, { status: 400 });
    }

    const passwordError = validatePasswordLength(password);
    if (passwordError) {
      return Response.json({ error: passwordError }, { status: 400 });
    }

    if (password !== confirmPassword) {
      console.log(`Password mismatch`);
      return Response.json(
        { error: "Passwords do not match." },
        { status: 400 },
      );
    }

    // Placed ahead of the findOne that returns 409, so the existence disclosure
    // below is throttled rather than free. Limits set by the project owner on
    // 2026-07-22; the per-IP figure is deliberately generous because much of
    // the userbase is behind Pakistani carrier CGNAT and campus/office signup
    // drives are a real acquisition motion — a false-positive block costs more
    // than the enumeration it would prevent.
    //
    // What these actually buy: the per-email limit does nothing against
    // enumeration (an enumerator queries each address once) — it bounds
    // mailbombing of one targeted address. The per-IP limit is the only
    // enumeration control and is weak against rented residential proxies. The
    // strongest justification is cost and deliverability: signup sends a
    // verification OTP, so every unthrottled POST is an outbound send against
    // the provider quota and sender reputation. checkRateLimit fails open if
    // Mongo is unavailable, so none of this is a guarantee — the unique-email
    // constraint remains signup's hard floor.
    const ipLimit = await checkRateLimit(
      "signup:ip",
      clientIp(req),
      20,
      60 * 60 * 1000,
    );
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const emailLimit = await checkRateLimit(
      "signup:email",
      hashKey(email),
      10,
      60 * 60 * 1000,
    );
    if (emailLimit.limited)
      return rateLimitResponse(emailLimit.retryAfterSeconds);

    const existingUser = await findUserByEmail(email);

    if (existingUser) {
      console.log(`Signup attempt with existing email`);
      return Response.json(
        { error: "This email is already in use." },
        { status: 409 },
      );
    }

    /*
     * Only what was actually sent. A missing coordinate is absent, not null:
     * `latitude` and `longitude` are NOT NULL text columns, and passing null
     * threw AFTER the row was created — a 500 with an account behind it.
     */
    const placeFrom = (): Record<string, unknown> => {
      const place: Record<string, unknown> = { address, province, city, town };
      if (latitude !== null && latitude !== undefined) place.latitude = latitude;
      if (longitude !== null && longitude !== undefined) place.longitude = longitude;
      return place;
    };

    const otpBlock = (code: string) => ({
      otpHash: hashOtp(code),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      attempts: 0,
      lastSentAt: new Date().toISOString(),
    });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const mintId = await generateMintId();

    const otp = generateOtp();

    /*
     * All of it, or none of it.
     *
     * These ran as four separate statements, and the second one threw on a
     * signup that carried no pin: `latitude` and `longitude` are NOT NULL text
     * columns, the destructure above defaults them to `null`, and updateUser
     * skips `undefined` but passes `null` straight through. The row was
     * already created by then, so the caller got a 500 and an account —
     * signed up, no points, no verification code, able to log in and unable to
     * verify. Signing up again said "email already in use", which is how this
     * reached us as a bug about deleted accounts.
     *
     * inTransaction exists for precisely this and its own comment says so: it
     * was written after BrandHub signup left people with an org and a login
     * and no brand. Consumer signup had the same shape and never got it.
     */
    /*
     * Somebody coming back.
     *
     * findUserByEmail excludes deleted rows, so the 409 above did not fire for
     * them — and this is where they are recognised. The row is revived rather
     * than replaced, which is the whole point: the id is what every
     * one-per-person guard is written against, and a new one would let them
     * claim the same deal a second time.
     *
     * They return as themselves with nothing. No points, no history, and no
     * second signup grant — the hundred are for joining, and they have joined
     * before. The verification code is reissued because the password is new.
     */
    const revived = await inTransaction(async (tx) => {
      const back = await reviveUser(
        email,
        { userName, password: hashedPassword, phone },
        tx,
      );
      if (!back) return null;
      await updateUser(back._id, placeFrom(), tx);
      await setUserOtp(back._id, "emailVerification", otpBlock(otp), tx);
      return back;
    });

    const newUser = revived ?? (await inTransaction(async (tx) => {
      const created = await createUser(
        { userName, email, password: hashedPassword, phone, mintId },
        tx,
      );

      // The address block and the starting points are not createUser's to
      // accept: points are server-granted, and a signup that could set them is
      // a signup that could mint them.
      //
      // Only what was actually sent. A missing coordinate is absent, not null:
      // these columns cannot hold null, and the empty string is what "no pin
      // yet" means everywhere else in this table.
      await updateUser(created._id, placeFrom(), tx);

      await addPoints(created._id, 100, tx);
      await setUserOtp(created._id, "emailVerification", otpBlock(otp), tx);
      return created;
    }));

    try {
      await sendSignupEmail(email, otp);
    } catch (emailErr) {
      console.error("Signup email failed to send:", emailErr);
    }

    const payload = { id: newUser._id };
    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    // Re-read so the response carries the address and points just written —
    // and through the default projection, which cannot include the OTP hash
    // this route has just set.
    const userResponse = await findUserByEmail(email);

    return Response.json({
      success: true,
      message: "Please check your email for verification.",
      token: `Bearer ${token}`,
      user: userResponse,
    });
  } catch (error) {
    console.error(
      `${logPrefix("users:signup")} unhandled error:`,
      error instanceof Error ? error.message : "unknown",
    );
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
