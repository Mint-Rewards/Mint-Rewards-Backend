import jwt, { JwtPayload } from "jsonwebtoken";

export type DecodedAuthToken = JwtPayload | string | null;

export type RequestWithAuthHeader = {
  headers?: {
    authorization?: string;
  };
};

type DecodedTokenWithUser = JwtPayload & {
  id?: string;
};

/**
 * Safely decode a bearer token from the given request headers.
 */
export async function checkAuth(
  req: RequestWithAuthHeader,
): Promise<DecodedAuthToken> {
  try {
    const authorization = req?.headers?.authorization;

    if (!authorization) {
      return null;
    }

    const [scheme, bearerToken] = authorization.split(" ");

    if (scheme !== "Bearer" || !bearerToken) {
      return null;
    }

    const jwtSecret =
      process.env.JWT_SECRET ||
      process.env.NEXTAUTH_SECRET ||
      process.env.NEXT_JWT_SECRET;

    if (!jwtSecret) {
      return null;
    }

    const verified = jwt.verify(bearerToken, jwtSecret);
    return verified ?? null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract the authenticated user id from Authorization header payload.
 */
export async function getAuthenticatedUserId(
  req: RequestWithAuthHeader,
): Promise<string | null> {
  const decoded = await checkAuth(req);

  if (!decoded || typeof decoded === "string") {
    return null;
  }

  const tokenPayload = decoded as DecodedTokenWithUser;
  const userId = tokenPayload.id ?? tokenPayload.sub;

  return typeof userId === "string" && userId.trim() ? userId : null;
}

export default checkAuth;
