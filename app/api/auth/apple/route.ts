import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import dbConnect from '@/lib/mongodb';
import { UserModel } from '@/lib/models';
import { SignOptions } from 'jsonwebtoken';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { serverEnv, logPrefix } from '@/lib/env';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

// Both validated at boot in lib/env.ts. APPLE_BUNDLE_ID in particular is
// required there, so no code path below can reach jwtVerify() with an
// undefined audience — the previous runtime 500 guard is now unreachable
// by construction and has been removed.
const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;
const APPLE_BUNDLE_ID = serverEnv.appleBundleId;

async function generateMintId(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const mintId = (Math.floor(Math.random() * 90000000) + 10000000).toString();
    const existing = await UserModel.findOne({ mintId });
    if (!existing) {
      return mintId;
    }
  }
  throw new Error('Unable to allocate a unique mint ID');
}

export async function POST(req: NextRequest) {
  try {
    const { identityToken, fullName } = await req.json();

    if (!identityToken) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'No identity token provided' },
        { status: 400 }
      );
    }

    // Verify the identity token against Apple's public keys. `audience` is
    // the environment's bundle ID (dev: com.mintrewards.app.dev), so a token
    // minted for the other environment's bundle fails the aud check here.
    const JWKS = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
    const { payload } = await jwtVerify(identityToken, JWKS, {
      issuer: APPLE_ISSUER,
      audience: APPLE_BUNDLE_ID,
    });

    const sub = payload.sub as string;
    const email = payload.email as string | undefined;

    if (!sub) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'Invalid token payload' },
        { status: 401 }
      );
    }

    await dbConnect();

    // 1. Try to find by Apple's stable user ID first
    let user = await UserModel.findOne({ appleId: sub });

    // 2. Fall back to email match (covers Google/email users signing in with Apple
    //    for the first time using the same email)
    if (!user && email) {
      user = await UserModel.findOne({ email: email.toLowerCase() });
      if (user) {
        user.appleId = sub;
        await user.save();
      }
    }

    // 3. Create a new user if none found
    if (!user) {
      const givenName = fullName?.givenName ?? '';
      const familyName = fullName?.familyName ?? '';
      const displayName =
        [givenName, familyName].filter(Boolean).join(' ').trim() ||
        (email ? email.split('@')[0] : 'User');

      const mintId = await generateMintId();
      const randomPassword = await bcrypt.hash(
        crypto.randomBytes(32).toString('hex'),
        10
      );

      user = await UserModel.create({
        userName: displayName,
        email: email?.toLowerCase() ?? `${sub}@privaterelay.appleid.com`,
        password: randomPassword,
        avatar: '',
        appleId: sub,
        mintId,
        emailVerified: true,
        firstTimeLogin: true,
      });
    }

    const jwtPayload = { id: user.id };
    const token = jwt.sign(jwtPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions['expiresIn'],
    });

    const { password: _password, ...userResponse } = user.toObject();

    return NextResponse.json({
      Status: 'Success',
      data: {
        ...userResponse,
        token: `Bearer ${token}`,
      },
    });
  } catch (error: any) {
    console.error(`${logPrefix('auth:apple')} verification failed:`, error.message);
    return NextResponse.json(
      { Status: 'Error', ErrorMessage: 'Authentication failed' },
      { status: 500 }
    );
  }
}
