import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { EDGE_ALLOWED_ORIGINS } from "@/lib/edgeEnv";

/**
 * Exact-match only. The previous implementation fell back to accepting any
 * http://localhost:* origin whenever the allowlist was empty and NODE_ENV was
 * not "production" — a pattern match that reflects an attacker-chosen origin.
 * That is inert today (no cookies are used), but it is the classic credentialed
 * -CORS bypass the moment anyone adds them, so it is gone. Local development
 * origins now belong in the dev project's ALLOWED_ORIGINS like any other entry.
 *
 * Set per Vercel project: the dev deployment and the prod deployment carry
 * different values. See .env.example.
 */
function isAllowedOrigin(origin: string): boolean {
  return EDGE_ALLOWED_ORIGINS.has(origin.replace(/\/+$/, ""));
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");
  // Requests without an Origin header (mobile apps, curl, server-to-server)
  // pass through untouched — CORS is browser-only enforcement.
  const allowed = origin !== null && isAllowedOrigin(origin);

  if (request.method === "OPTIONS") {
    const headers: Record<string, string> = { Vary: "Origin" };
    if (allowed && origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] =
        "GET, POST, PUT, PATCH, DELETE, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      headers["Access-Control-Max-Age"] = "86400";
    }
    return new NextResponse(null, { status: 204, headers });
  }

  const response = NextResponse.next();
  response.headers.set("Vary", "Origin");
  if (allowed && origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    // Without this, browsers hide Retry-After from JS on 429 responses and the
    // web client can't render the wait time.
    response.headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
