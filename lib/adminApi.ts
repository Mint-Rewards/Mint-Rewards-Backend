/**
 * Client for the operations API, used only on a household's own behalf.
 *
 * Collections live in the admin API, not here. A household needs two things
 * from it — what am I being asked, and here is my answer — and neither can go
 * through the app directly: those endpoints are service-authenticated, and a
 * mobile binary cannot hold a service credential.
 *
 * The userId is always taken from the caller's verified JWT and put into the
 * path here. It is never read from a request body, because a client able to
 * name its own userId could answer for somebody else's household.
 */
import { serverEnv } from "@/lib/env";

export interface Invitation {
  collectionId: number;
  name: string;
  scheduledDate: string;
  timeSlot: string;
  responseDeadlineAt: string | null;
  status: "INVITED" | "ACCEPTED" | "DECLINED";
  invitedAt: string | null;
  respondedAt: string | null;
  captainName: string | null;
}

export type AdminApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; error: string };

function configured(): { url: string; token: string } | null {
  const { adminApiUrl, adminApiToken } = serverEnv;
  if (!adminApiUrl || !adminApiToken) return null;
  return { url: adminApiUrl.replace(/\/+$/, ""), token: adminApiToken };
}

async function call<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" },
): Promise<AdminApiResult<T>> {
  const target = configured();
  if (!target) return { ok: false, error: "operations API not configured" };

  try {
    const res = await fetch(`${target.url}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // A phone is waiting on this. Better a clear failure than a spinner.
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: parsed?.error ?? parsed?.message ?? `operations API returned ${res.status}`,
      };
    }
    return { ok: true, data: parsed as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function listInvitations(userId: string): Promise<AdminApiResult<{ invitations: Invitation[] }>> {
  return call(`/household/${encodeURIComponent(userId)}/invitations`);
}

export function respondToInvitation(
  userId: string,
  collectionId: number,
  response: "ACCEPTED" | "DECLINED",
): Promise<AdminApiResult<{ collectionId: number; status: string }>> {
  return call(`/household/${encodeURIComponent(userId)}/collections/${collectionId}/response`, {
    method: "POST",
    body: { response },
  });
}
