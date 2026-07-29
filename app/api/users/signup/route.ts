import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
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
import { serverEnv, logPrefix } from "@/lib/env";

const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;
const MAX_EMAIL_LENGTH = 254;

async function generateMintId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const mintId = (Math.floor(Math.random() * 90000000) + 10000000).toString();
    const existingUser = await UserModel.findOne({ mintId });
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

    // Label classes exclude '.', so each dot boundary has exactly one possible
    // split and the match is linear. The previous /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    // let '.' match inside the domain classes too, making the split ambiguous
    // and backtracking polynomial on non-matching input (CodeQL js/polynomial-redos).
    const emailRegex = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
    if (!emailRegex.test(email)) {
      console.log("Invalid email format");
      return Response.json({ error: "Invalid email format." }, { status: 400 });
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
    if (emailLimit.limited) return rateLimitResponse(emailLimit.retryAfterSeconds);

    const existingUser = await UserModel.findOne({ email });

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

    const newUser = new UserModel({
      userName,
      email,
      password: hashedPassword,
      phone,
      address,
      province,
      city,
      town,
      latitude,
      longitude,
      mintId,
      points: 100,
      emailVerified: false,
      emailVerification: {
        otpHash: hashOtp(otp),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 0,
        lastSentAt: new Date(),
      },
    });

    await newUser.save();

    // Handle referral rewards
    const referralUsers = await UserModel.find({ referrals: { $in: [email] } });

    if (referralUsers.length > 0) {
      const referralUser = referralUsers[0];

      if (referralUser.email !== newUser.email) {
        newUser.points = 150;
        await newUser.save();

        referralUser.points += 50;
        await referralUser.save();
      }
    }

    try {
      await sendSignupEmail(email, otp);
    } catch (emailErr) {
      console.error("Signup email failed to send:", emailErr);
    }

    const payload = { id: newUser.id };
    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    // select:false doesn't apply to freshly constructed docs — strip the OTP hash.
    const {
      password: _password,
      emailVerification: _emailVerification,
      ...userResponse
    } = newUser.toObject();

    return Response.json({
      success: true,
      message: "Please check your email for verification.",
      token: `Bearer ${token}`,
      user: userResponse,
    });
  } catch (error) {
    console.error(`${logPrefix("users:signup")} unhandled error:`, error instanceof Error ? error.message : "unknown");
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
