import bcrypt from "bcryptjs";
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

export async function GET() {
  //testing route
  return Response.json({ message: "Login API is alive" });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email) {
      return Response.json(
        { error: "You must enter an email." },
        { status: 400 },
      );
    }

    if (!password) {
      return Response.json(
        { error: "You must enter a password." },
        { status: 400 },
      );
    }

    const normalizedEmail = email.toLowerCase();

    const ipLimit = await checkRateLimit(
      "login:ip",
      clientIp(req),
      10,
      5 * 60 * 1000,
    );
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const emailLimit = await checkRateLimit(
      "login:email",
      hashKey(normalizedEmail),
      5,
      15 * 60 * 1000,
    );
    if (emailLimit.limited) return rateLimitResponse(emailLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await UserModel.findOne({ email: normalizedEmail });

    // Run bcrypt.compare regardless of whether the user was found so that
    // response timing stays constant and prevents email enumeration.
    const DUMMY_HASH =
      "$2a$10$CwTycUXWue0Thq9StjUM0uJ8vTVoRxvBn/hSaKjrIJxJXX2vfLrLK";
    const isMatch = await bcrypt.compare(
      password,
      user?.password || DUMMY_HASH,
    );

    if (!user || !isMatch) {
      return Response.json(
        {
          success: false,
          error: "Invalid email or password.",
        },
        { status: 401 },
      );
    }

    if (!JWT_SECRET) {
      return Response.json(
        { error: "Server JWT configuration is missing." },
        { status: 500 },
      );
    }

    const payload = { id: user.id };

    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    if (!token) {
      throw new Error();
    }

    const userCount = await UserModel.countDocuments();

    const { password: _password, ...userResponse } = user.toObject();

    return Response.json({
      users: userCount,
      success: true,
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
