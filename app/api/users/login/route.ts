import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import sendProfileCompletionEmail from "@/emailServices/profileNotComplete";

const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export async function GET() {
  //testing route
  return Response.json({ message: "Login API is alive" });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    console.log("Login API called");
    const body = await req.json();
    const { email, password } = body;

    console.log("Received email:", email);
    if (!email) {
      return Response.json(
        { error: "You must enter an email." },
        { status: 400 },
      );
    }

    if (!password) {
      return Response.json(
        { error: "You must enter a password." },
        { status: 400 },
      );
    }

    const normalizedEmail = email.toLowerCase();

    console.log("Looking for user with email:", normalizedEmail);
    const user = await UserModel.findOne({ email: normalizedEmail });
    console.log("User found:", user);

    if (!user) {
      return Response.json(
        { error: "User not found with given email." },
        { status: 404 },
      );
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return Response.json(
        {
          success: false,
          error: "Password Incorrect",
        },
        { status: 400 },
      );
    }

    if (!user.address || !user.phone) {
      // TODO: fix
      // await sendProfileCompletionEmail(email, user.userName);
    }

    if (!JWT_SECRET) {
      return Response.json(
        { error: "Server JWT configuration is missing." },
        { status: 500 },
      );
    }

    const payload = { id: user.id };

    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    if (!token) {
      throw new Error();
    }

    const userCount = await UserModel.countDocuments();

    const userResponse = user.toObject();
    delete userResponse.password;

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
