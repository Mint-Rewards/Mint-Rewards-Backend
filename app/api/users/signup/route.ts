import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import {
  addPoints,
  createUser,
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

async function generateMintId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const mintId = (Math.floor(Math.random() * 90000000) + 10000000).toString();
    const existingUser = await findUserByMintId(mintId);
    if (!existingUser) {
      return mintId;
    }
  }

  throw new Error("Unable to generate a unique mint ID after 20 attempts.");
}

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

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const mintId = await generateMintId();

    const otp = generateOtp();

    const newUser = await createUser({
      userName,
      email,
      password: hashedPassword,
      phone,
      mintId,
    });

    // The address block and the starting points are not createUser's to
    // accept: points are server-granted, and a signup that could set them is
    // a signup that could mint them.
    await updateUser(newUser._id, {
      address,
      province,
      city,
      town,
      latitude,
      longitude,
    });
    await addPoints(newUser._id, 100);
    await setUserOtp(newUser._id, "emailVerification", {
      otpHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      attempts: 0,
      lastSentAt: new Date().toISOString(),
    });

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
