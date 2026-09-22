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
      // A phone IS waiting on this one, so it stays tighter than the
      // notification client — but not so tight that a cold function in
      // another region reads as an outage. 12s is past any reasonable cold
      // start and still short enough to fail visibly rather than hang.
      signal: AbortSignal.timeout(12000),
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

export interface InboxNotification {
  id: number;
  event: string;
  title: string;
  body: string;
  data: Record<string, string>;
  createdAt: string;
  readAt: string | null;
}

export interface Inbox {
  notifications: InboxNotification[];
  unread: number;
  /** Cursor for the next page, or null when this one reached the end. */
  nextBefore: number | null;
}

/**
 * What this household has been told.
 *
 * Reads notification records rather than deliveries: a message sent while they
 * had no device registered is still theirs to read, and that is exactly the
 * case on the first collection anyone is invited to.
 */
export function listNotifications(
  userId: string,
  opts: { limit?: number; before?: number } = {},
): Promise<AdminApiResult<Inbox>> {
  const query = new URLSearchParams({
    audience: "USER",
    subjectId: userId,
    ...(opts.limit ? { limit: String(opts.limit) } : {}),
    ...(opts.before ? { before: String(opts.before) } : {}),
  });
  return call(`/notifications?${query.toString()}`);
}

/** Marks messages read. Omitting ids means everything this household has. */
export function markNotificationsRead(
  userId: string,
  ids?: number[],
): Promise<AdminApiResult<{ read: number }>> {
  return call("/notifications/read", {
    method: "POST",
    body: { audience: "USER", subjectId: userId, ...(ids?.length ? { ids } : {}) },
  });
}
