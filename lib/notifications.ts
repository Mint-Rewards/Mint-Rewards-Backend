/**
 * Client for the notification service.
 *
 * The app cannot register its own push token: /devices on the notification
 * service is authenticated service-to-service, and a mobile binary cannot hold
 * a service credential — anyone who unzips the IPA has it. So the app talks to
 * this backend with the user's own JWT, and this module attaches the service
 * credential on the way through.
 *
 * FAIL-SOFT throughout. A device that cannot be registered means a missed push
 * later, which is worse than nothing but much better than a login that fails
 * because a downstream service blinked.
 */
import { serverEnv } from "@/lib/env";

export type Audience = "USER" | "CAPTAIN" | "ADMIN";
export type Platform = "IOS" | "ANDROID" | "WEB";

export interface DeviceRegistration {
  audience: Audience;
  subjectId: string;
  platform: Platform;
  token: string;
  appVersion?: string;
}

export interface NotificationsResult {
  ok: boolean;
  status?: number;
  error?: string;
}

function configured(): { url: string; token: string } | null {
  const { notificationsUrl, notificationsToken } = serverEnv;
  if (!notificationsUrl || !notificationsToken) return null;
  return { url: notificationsUrl.replace(/\/+$/, ""), token: notificationsToken };
}

async function call(
  path: string,
  method: "POST" | "DELETE",
  body: unknown,
): Promise<NotificationsResult> {
  const target = configured();
  if (!target) return { ok: false, error: "notifications not configured" };

  try {
    const res = await fetch(`${target.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify(body),
      // A push registration is never worth holding a login open for.
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Binds a push token to a user. Idempotent — the service upserts on the token. */
export function registerDevice(
  device: DeviceRegistration,
): Promise<NotificationsResult> {
  return call("/devices", "POST", device);
}

/**
 * Releases a token on sign-out.
 *
 * Without this the next person to sign in on the same handset keeps receiving
 * the previous user's notifications until they happen to register, which is a
 * privacy problem rather than an inconvenience.
 */
export function unregisterDevice(token: string): Promise<NotificationsResult> {
  return call("/devices", "DELETE", { token });
}
