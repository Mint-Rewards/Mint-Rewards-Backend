import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rateLimit";
import { serverEnv } from "@/lib/env";
import { validatePasswordLength } from "@/lib/password";

const JWT_SECRET = serverEnv.jwtSecret;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { resetToken, password } = body;

    const ipLimit = await checkRateLimit(
      "set-password:ip",
      clientIp(req),
      10,
      15 * 60 * 1000,
    );
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    if (!password || typeof password !== "string") {
      return Response.json(
        { error: "You must enter a new password." },
        { status: 400 },
      );
    }

    const passwordError = validatePasswordLength(password);
    if (passwordError) {
      return Response.json({ error: passwordError }, { status: 400 });
    }

    if (!resetToken || typeof resetToken !== "string") {
      return Response.json(
        { error: "A reset token is required." },
        { status: 401 },
      );
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(resetToken, JWT_SECRET) as jwt.JwtPayload;
    } catch {
      return Response.json(
        { error: "Invalid or expired reset session." },
        { status: 401 },
      );
    }

    if (payload.purpose !== "pwreset" || !payload.sub) {
      return Response.json(
        { error: "Invalid or expired reset session." },
        { status: 401 },
      );
    }

    await connectToDatabase();

    const user = await UserModel.findById(payload.sub);
    if (!user) {
      return Response.json(
        { error: "Invalid or expired reset session." },
        { status: 401 },
      );
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    user.passwordReset = undefined;
    await user.save();

    return Response.json({
      success: true,
      message: "Password successfully updated.",
    });
  } catch (error) {
    console.error("set-password error:", error);
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
