import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import dbConnect from "@/lib/mongodb";
import {
  addPoints,
  createUser,
  findUserByAppleId,
  findUserByEmail,
  findUserByMintId,
  updateUser,
} from "@/lib/repositories/users";
import { SignOptions } from "jsonwebtoken";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { serverEnv } from "@/lib/env";

const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;

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

export async function POST(req: NextRequest) {
  try {
    const { identityToken, fullName } = await req.json();

    if (!identityToken) {
      return NextResponse.json(
        { Status: "Error", ErrorMessage: "No identity token provided" },
        { status: 400 },
      );
    }

    // Verify the identity token against Apple's public keys
    const JWKS = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
    const { payload } = await jwtVerify(identityToken, JWKS, {
      issuer: APPLE_ISSUER,
      audience: serverEnv.appleBundleId,
    });

    const sub = payload.sub as string;
    const email = payload.email as string | undefined;

    if (!sub) {
      return NextResponse.json(
        { Status: "Error", ErrorMessage: "Invalid token payload" },
        { status: 401 },
      );
    }

    await dbConnect();

    // 1. Try to find by Apple's stable user ID first
    let user = await findUserByAppleId(sub);

    // 2. Fall back to email match (covers Google/email users signing in with Apple
    //    for the first time using the same email)
    if (!user && email) {
      user = await findUserByEmail(email);
      if (user) user = await updateUser(user._id, { appleId: sub });
    }

    // 3. Create a new user if none found
    if (!user) {
      const givenName = fullName?.givenName ?? "";
      const familyName = fullName?.familyName ?? "";
      const displayName =
        [givenName, familyName].filter(Boolean).join(" ").trim() ||
        (email ? email.split("@")[0] : "User");

      const mintId = await generateMintId();
      const randomPassword = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        10,
      );

      user = await createUser({
        userName: displayName,
        email: email?.toLowerCase() ?? `${sub}@privaterelay.appleid.com`,
        password: randomPassword,
        appleId: sub,
        mintId,
        emailVerified: true,
      });
      // Baseline signup grant for ALL new Apple users, referred or not —
      // matches the 100 points in users/signup/route.ts. Granted rather than
      // set at creation: createUser does not accept points, because a signup
      // that can set them is a signup that can mint them.
      await addPoints(user._id, 100);
      user = (await findUserByAppleId(sub)) ?? user;
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
      },
    });
  } catch (error: any) {
    console.error("Apple auth error:", error.message, error.stack);
    return NextResponse.json(
      { Status: "Error", ErrorMessage: "Authentication failed" },
      { status: 500 },
    );
  }
}
