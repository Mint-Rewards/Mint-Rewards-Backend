import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client(process.env.GOOGLE_IOS_CLIENT_ID);

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
      audience: process.env.GOOGLE_IOS_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return NextResponse.json(
        { Status: 'Error', ErrorMessage: 'Invalid token' },
        { status: 401 }
      );
    }

    const { email, name, picture, sub: googleId } = payload;

    // TODO: Find or create user in MongoDB
    // const user = await User.findOneAndUpdate(
    //   { googleId },
    //   { email, name, picture, googleId },
    //   { upsert: true, new: true }
    // );

    return NextResponse.json({
      Status: 'Success',
      data: {
        email,
        name,
        picture,
        googleId,
      },
    });

  } catch (error: any) {
    console.error('Google auth error:', error.message);
    return NextResponse.json(
      { Status: 'Error', ErrorMessage: 'Authentication failed' },
      { status: 500 }
    );
  }
}