import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Comma-separated exact origins, e.g. "https://app.example.com,https://admin.example.com"
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Dev fallback: with no allowlist configured outside production, permit localhost.
  return (
    ALLOWED_ORIGINS.size === 0 &&
    process.env.NODE_ENV !== "production" &&
    /^http:\/\/localhost(:\d+)?$/.test(origin)
  );
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
