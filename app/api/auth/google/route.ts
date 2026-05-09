import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import dbConnect from '@/lib/mongodb';
import { UserModel } from '@/lib/models';
import { SignOptions } from 'jsonwebtoken';
import jwt from 'jsonwebtoken';

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
    const ticket = await client.verifyIdToken({
      idToken,
      audience: [
            process.env.GOOGLE_IOS_CLIENT_ID!,
            process.env.GOOGLE_WEB_CLIENT_ID!,
      ]
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'Invalid token' },
        { status: 401 }
      );
    }

    const { email, name, picture } = payload;

    await dbConnect();

    // Find user by email
    const user = await UserModel.findOne({ email: email?.toLowerCase() });

    if (!user) {
      return NextResponse.json({
        Status: 'Error',
        ErrorMessage: 'No account found with this Google email. Please register first.',
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
        picture, // from Google, in case you want to use it as fallback avatar
      },
    });

  } catch (error: any) {
    console.error('Google auth error:', error.message, error.stack);
    return NextResponse.json(
        { Status: 'Error', ErrorMessage: error.message }, // ← surface real error
        { status: 500 }
    );
    }
}