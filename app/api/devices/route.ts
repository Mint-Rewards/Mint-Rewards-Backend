/**
 * Push device registration for the mobile app.
 *
 * The notification service owns the device table, but its /devices endpoint is
 * authenticated service-to-service and the app cannot hold a service
 * credential — anyone who unzips the IPA would have it. So the app calls this
 * with the user's own bearer token and the backend forwards with the service
 * credential attached.
 *
 * The subject the token is bound to is taken from the JWT, never from the body.
 * A client that could name its own subjectId could subscribe itself to someone
 * else's notifications.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { registerDevice, unregisterDevice, type Platform } from "@/lib/notifications";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

const PLATFORMS: readonly Platform[] = ["IOS", "ANDROID", "WEB"];

const authenticate = (req: Request) =>
  getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });

export async function POST(req: Request) {
  const userId = await authenticate(req);
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  // Limited per USER, not per IP, and deliberately after authentication.
  //
  // Mobile carriers here put very large numbers of subscribers behind one
  // CGNAT address, so an IP bucket is shared by thousands of unrelated people
  // — an IP limit would lock real users out of push registration for reasons
  // they cannot see or fix. `clientIp` also collapses to the literal string
  // "unknown" when no proxy header is present, which is one global bucket for
  // everyone. Per-user is the meaningful unit: registration is authenticated
  // and idempotent, so the only thing worth bounding is one account looping.
  const limit = await checkRateLimit("devices:user", userId, 30, 15 * 60 * 1000);
  if (limit.limited) return rateLimitResponse(limit.retryAfterSeconds);

  let body: { token?: unknown; platform?: unknown; appVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 8 || token.length > 4096) {
    return Response.json({ error: "A push token is required." }, { status: 400 });
  }

  const platform = String(body.platform ?? "").toUpperCase() as Platform;
  if (!PLATFORMS.includes(platform)) {
    return Response.json(
      { error: `platform must be one of ${PLATFORMS.join(", ")}.` },
      { status: 400 },
    );
  }

  const appVersion =
    typeof body.appVersion === "string" && body.appVersion.trim()
      ? body.appVersion.trim().slice(0, 32)
      : undefined;

  const result = await registerDevice({
    audience: "USER",
    subjectId: userId,
    platform,
    token,
    appVersion,
  });

  if (!result.ok) {
    // Reported, not thrown: the caller is a phone that has just signed in, and
    // there is nothing it can usefully do about a downstream outage. It will
    // register again on the next launch.
    console.warn("[devices] registration failed", result.error);
    return Response.json(
      { Status: "Unavailable", error: "Could not register for notifications." },
      { status: 503 },
    );
  }

  return Response.json({ Status: "Success" }, { status: 201 });
}

export async function DELETE(req: Request) {
  const userId = await authenticate(req);
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return Response.json({ error: "A push token is required." }, { status: 400 });
  }

  const result = await unregisterDevice(token);
  if (!result.ok) {
    console.warn("[devices] unregister failed", result.error);
  }
  // Always 200. Sign-out must not fail because the notification service is
  // down, and the token is released on the next registration anyway.
  return Response.json({ Status: "Success" });
}
