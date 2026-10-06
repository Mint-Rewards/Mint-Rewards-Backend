import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import dbConnect from "@/lib/mongodb";
import {
  addPoints,
  createUser,
  reviveUser,
  findUserByEmail,
  findUserByMintId,
} from "@/lib/repositories/users";
import { SignOptions } from "jsonwebtoken";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { serverEnv, logPrefix } from "@/lib/env";
import { googleAudiences } from "@/lib/googleAudiences";

async function generateMintId(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const mintId = (Math.floor(Math.random() * 90000000) + 10000000).toString();
    const existing = await findUserByMintId(mintId);
    if (!existing) {
      return mintId;
    }
  }
  throw new Error("Unable to allocate a unique mint ID");
}

// All validated at boot in lib/env.ts. Non-null assertions on process.env
// claimed a guarantee TypeScript could not check — an unset client ID became
// `audience: [undefined, undefined]` at runtime, failing every token silently.
const client = new OAuth2Client(serverEnv.googleIosClientId);

const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;

export async function POST(req: NextRequest) {
  try {
    const { idToken, intent } = await req.json();

    /*
     * Whether this caller is allowed to create an account.
     *
     * Both buttons hit this route with the same payload, so "Sign in with
     * Google" on the login screen silently created accounts — a person who had
     * never registered was signed up by a button that said sign IN, and
     * counted in the analytics as a login.
     *
     * `intent: "login"` refuses to create. Absent, it still creates, because
     * every build already on a phone sends no intent at all and making the
     * default strict would break Sign Up with Google for all of them.
     */
    const mayCreate = intent !== "login";

    /*
     * Verification is the only gate. An `if (!idToken)` used to stand here
     * answering 400; verifyIdToken rejects an absent token exactly as it
     * rejects a forged one, so the check decided nothing while putting a
     * condition on attacker-supplied input in front of account creation.
     * See the same note in ../apple/route.ts.
     */
    // Verify the token with Google
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        // Current clients plus the superseded ones still live in older
        // installs — see lib/googleAudiences.ts for when to drop those.
        audience: googleAudiences(
          serverEnv.googleIosClientId,
          serverEnv.googleWebClientId,
        ),
      });
      payload = ticket.getPayload();
    } catch (error: any) {
      console.error(
        `${logPrefix("auth:google")} verification failed:`,
        error.message,
      );
      payload = null;
    }

    if (!payload) {
      return NextResponse.json(
        { Status: "Error", ErrorMessage: "Invalid token" },
        { status: 401 },
      );
    }

    const { email, name, picture } = payload;

    await dbConnect();

    // Find or create user
    let user = email ? await findUserByEmail(email) : null;

    if (!user && !mayCreate) {
      return NextResponse.json(
        {
          Status: "Error",
          ErrorCode: "NO_ACCOUNT",
          ErrorMessage:
            "No Mint Rewards account uses this Google address yet. Create one from Sign Up.",
        },
        { status: 404 },
      );
    }

    /*
     * Somebody coming back, before anybody is created.
     *
     * findUserByEmail excludes deleted rows, so a returning person reads as
     * absent above. Reviving the row keeps their id — which is what stops them
     * claiming a deal they have already claimed — and withholds the hundred
     * points, because those are for joining and they joined once already.
     */
    if (!user && email) {
      user = await reviveUser(email, { userName: name || undefined });
    }

    const created = !user;
    if (!user) {
      const mintId = await generateMintId();
      const randomPassword = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        10,
      );
      user = await createUser({
        userName: name || email?.split("@")[0] || "User",
        email: email?.toLowerCase() ?? "",
        password: randomPassword,
        avatar: picture || "",
        mintId,
        emailVerified: true,
      });
      // Baseline signup grant for ALL new Google users, referred or not —
      // matches the 100 points in users/signup/route.ts.
      await addPoints(user._id, 100);
    }
    const jwtPayload = { id: user._id };
    const token = jwt.sign(jwtPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    // The repository's default projection already excludes the password.
    const userResponse = user;

    return NextResponse.json({
      Status: "Success",
      data: {
        ...userResponse,
        token: `Bearer ${token}`,
        // Whether this call made the account. The screen a person happened to
        // start on is not the event that occurred, and the client was firing
        // one based on the other.
        created,
        picture, // from Google, in case you want to use it as fallback avatar
      },
    });
  } catch (error: any) {
    console.error("Google auth error:", error.message, error.stack);
    return NextResponse.json(
      { Status: "Error", ErrorMessage: "Authentication failed" },
      { status: 500 },
    );
  }
}
