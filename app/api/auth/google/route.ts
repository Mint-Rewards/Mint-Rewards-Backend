import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import dbConnect from '@/lib/mongodb';
import { UserModel } from '@/lib/models';
import { SignOptions } from 'jsonwebtoken';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

async function generateMintId(): Promise<string> {
  const mintId = (Math.floor(Math.random() * 90000000) + 10000000).toString();
  const existing = await UserModel.findOne({ mintId });
  return existing ? generateMintId() : mintId;
}

const client = new OAuth2Client(process.env.GOOGLE_IOS_CLIENT_ID);

const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

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
        audience: [
              process.env.GOOGLE_IOS_CLIENT_ID!,
              process.env.GOOGLE_WEB_CLIENT_ID!,
        ]
      });
      payload = ticket.getPayload();
    } catch {
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