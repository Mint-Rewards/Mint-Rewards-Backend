import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import dbConnect from '@/lib/mongodb';
import { UserModel } from '@/lib/models';
import { SignOptions } from 'jsonwebtoken';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { serverEnv, logPrefix } from '@/lib/env';
import { googleAudiences } from '@/lib/googleAudiences';

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

// All validated at boot in lib/env.ts. Non-null assertions on process.env
// claimed a guarantee TypeScript could not check — an unset client ID became
// `audience: [undefined, undefined]` at runtime, failing every token silently.
const client = new OAuth2Client(serverEnv.googleIosClientId);

const JWT_SECRET = serverEnv.jwtSecret;
const JWT_EXPIRES_IN = serverEnv.jwtExpiresIn;

export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();

    if (!idToken) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'No ID token provided' },
        { status: 400 }
      );
    }

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
      console.error(`${logPrefix('auth:google')} verification failed:`, error.message);
      payload = null;
    }

    if (!payload) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'Invalid token' },
        { status: 401 }
      );
    }

    const { email, name, picture } = payload;

    await dbConnect();

    // Find or create user
    let user = await UserModel.findOne({ email: email?.toLowerCase() });

    if (!user) {
      const mintId = await generateMintId();
      const randomPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      user = await UserModel.create({
        userName: name || email?.split('@')[0] || 'User',
        email: email?.toLowerCase(),
        password: randomPassword,
        avatar: picture || '',
        mintId,
        // Baseline signup grant for ALL new Google users, referred or not —
        // matches the `points: 100` in users/signup/route.ts. Without it these
        // accounts fell through to the schema default of 0.
        points: 100,
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
        picture, // from Google, in case you want to use it as fallback avatar
      },
    });

  } catch (error: any) {
    console.error('Google auth error:', error.message, error.stack);
    return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'Authentication failed' },
        { status: 500 }
    );
    }
}