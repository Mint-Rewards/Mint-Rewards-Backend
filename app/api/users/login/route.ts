import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import { countUsers, findUserByEmailForLogin } from "@/lib/repositories/users";
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

    /*
     * Absent credentials take the same path as wrong ones.
     *
     * Two presence checks used to stand here answering 400. They put a
     * condition on attacker-supplied input in front of authentication — the
     * shape CodeQL's user-controlled-bypass rule objects to — and they told
     * a caller which field was missing, which is a distinction an
     * authentication endpoint should not be drawing. An empty email finds no
     * user and an empty password matches no hash, so both arrive at the same
     * "Invalid email or password." by the route below.
     *
     * Coerced rather than trusted: the values come straight off the request
     * body, and `undefined.toLowerCase()` or `bcrypt.compare(undefined, ...)`
     * would throw into the outer catch and answer 500 for what is simply a
     * failed login. The app validates both fields before sending, so nobody
     * loses a message they were seeing.
     */
    const normalizedEmail = String(email ?? "").toLowerCase();
    const suppliedPassword = String(password ?? "");

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
    if (emailLimit.limited)
      return rateLimitResponse(emailLimit.retryAfterSeconds);

    await connectToDatabase();

    const user = await findUserByEmailForLogin(normalizedEmail);

    // Run bcrypt.compare regardless of whether the user was found so that
    // response timing stays constant and prevents email enumeration.
    const DUMMY_HASH =
      "$2a$10$CwTycUXWue0Thq9StjUM0uJ8vTVoRxvBn/hSaKjrIJxJXX2vfLrLK";
    const isMatch = await bcrypt.compare(
      suppliedPassword,
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

    const payload = { id: user._id };

    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    if (!token) {
      throw new Error();
    }

    const userCount = await countUsers();

    // The login read is the one that carries the hash, so it is stripped here
    // rather than relied on being absent — every other read omits it already.
    const { password: _password, ...userResponse } = user;

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
