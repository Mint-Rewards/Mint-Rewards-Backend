import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import dbConnect from '@/lib/mongodb';
import { UserModel } from '@/lib/models';

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

    return NextResponse.json({
      Status: 'Success',
      data: {
        _id: user._id,
        userName: user.userName,
        email: user.email,
        avatar: user.avatar,
        points: user.points,
        mintId: user.mintId,
        role: user.role,
        firstTimeLogin: user.firstTimeLogin,
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