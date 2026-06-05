import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import dbConnect from '@/lib/mongodb';
import { UserModel } from '@/lib/models';
import { SignOptions } from 'jsonwebtoken';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

async function generateMintId(): Promise<string> {
  const mintId = (Math.floor(Math.random() * 90000000) + 10000000).toString();
  const existing = await UserModel.findOne({ mintId });
  return existing ? generateMintId() : mintId;
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

    const bundleId = process.env.APPLE_BUNDLE_ID;
    if (!bundleId) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'Server Apple configuration is missing.' },
        { status: 500 }
      );
    }

    // Verify the identity token against Apple's public keys
    const JWKS = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
    const { payload } = await jwtVerify(identityToken, JWKS, {
      issuer: APPLE_ISSUER,
      audience: bundleId,
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

    if (!JWT_SECRET) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'Server JWT configuration is missing.' },
        { status: 500 }
      );
    }

    const jwtPayload = { id: user.id };
    const token = jwt.sign(jwtPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions['expiresIn'],
    });

    const userResponse = user.toObject();
    delete userResponse.password;

    return NextResponse.json({
      Status: 'Success',
      data: {
        ...userResponse,
        token: `Bearer ${token}`,
      },
    });
  } catch (error: any) {
    console.error('Apple auth error:', error.message, error.stack);
    return NextResponse.json(
      { Status: 'Error', ErrorMessage: error.message },
      { status: 500 }
    );
  }
}
