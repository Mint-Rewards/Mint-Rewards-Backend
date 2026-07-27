import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import crypto from "crypto";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import sendSignupEmail from "@/emailServices/signupConfirmation";
import { generateOtp, hashOtp } from "@/lib/otp";

const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

async function generateMintId() {
  while (true) {
    const mintId = (Math.floor(Math.random() * 90000000) + 10000000).toString();
    const existingUser = await UserModel.findOne({ mintId });
    if (!existingUser) {
      return mintId;
    }
  }
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
      console.log("Missing required fields:", {
        userName,
        email,
        password: password ? "provided" : "missing",
        confirmPassword: confirmPassword ? "provided" : "missing",
      });
      return Response.json(
        { error: "All fields are required." },
        { status: 410 },
      );
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.log(`Invalid email format: ${email}`);
      return Response.json({ error: "Invalid email format." }, { status: 411 });
    }

    if (password !== confirmPassword) {
      console.log(`Password mismatch for email: ${email}`);
      return Response.json(
        { error: "Passwords do not match." },
        { status: 412 },
      );
    }

    const existingUser = await UserModel.findOne({ email });

    if (existingUser) {
      console.log(`Signup attempt with existing email: ${email}`);
      return Response.json(
        { error: "This email is already in use." },
        { status: 413 },
      );
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const mintId = await generateMintId();

    const verificationToken = crypto.randomBytes(20).toString("hex");

    // 6-digit OTP replaces the old emailed link: /api/users/verify-email was
    // never implemented on this branch, so the link in the previous signup mail
    // resolved to a 404 and no account could ever be verified.
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
      verificationToken,
    });

    await newUser.save();

    // Handle referral rewards
    const referralUsers = await UserModel.find({ referrals: { $in: [email] } });

    if (referralUsers.length > 0) {
      const referralUser = referralUsers[0];

      newUser.points = 150;
      await newUser.save();

      referralUser.points += 50;
      await referralUser.save();
    }

    try {
      await sendSignupEmail(email, otp);
    } catch (emailErr) {
      console.error("Signup email failed to send:", emailErr);
    }

    if (!JWT_SECRET) {
      return Response.json(
        { error: "Server JWT configuration is missing." },
        { status: 500 },
      );
    }

    const payload = { id: newUser.id };
    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    // select:false doesn't apply to freshly constructed docs — strip the OTP hash.
    const userResponse = newUser.toObject();
    delete userResponse.password;
    delete userResponse.emailVerification;

    return Response.json({
      success: true,
      message: "Please check your email for verification.",
      token: `Bearer ${token}`,
      user: userResponse,
    });
  } catch (error) {
    console.log(error);
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
