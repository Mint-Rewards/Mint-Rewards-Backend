/**
 * Pure helpers shared by lib/env.ts (Node runtime, fail-fast) and
 * lib/edgeEnv.ts (middleware runtime, fail-closed).
 *
 * Nothing in here reads process.env or throws — it exists so the two runtimes
 * parse the same strings the same way without middleware having to import the
 * strict validator, which would take the whole /api matcher down on a single
 * missing key.
 */

export const APP_ENVS = ["development", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export function isAppEnv(value: string | undefined): value is AppEnv {
  return value !== undefined && (APP_ENVS as readonly string[]).includes(value);
}

/**
 * Which environment variable supplies the connection string for this boot.
 *
 * APP_ENV=development prefers MONGODB_URI_TEST, so a local `next dev` reaches
 * the isolated test database rather than whatever MONGODB_URI happens to hold
 * — which, with a .env shared with the seed scripts, was the production
 * mint_rewards database. `npm run dev:testdb` did this by hand; nothing forced
 * it, and the plain `dev` script did not.
 *
 * Falls back to MONGODB_URI when no test URI is defined: the deployed dev
 * backend (Vercel Preview, branch dev) sets only MONGODB_URI and already
 * points it at the test database, so requiring MONGODB_URI_TEST there would
 * fail its boot on a variable it has no reason to carry.
 *
 * Production ignores MONGODB_URI_TEST entirely — a stray value in the
 * production environment must not be able to divert live traffic.
 */
export function resolveMongoUriKey(
  appEnv: AppEnv,
  mongodbUriTest: string | undefined,
): "MONGODB_URI" | "MONGODB_URI_TEST" {
  if (appEnv === "development" && mongodbUriTest?.trim()) {
    return "MONGODB_URI_TEST";
  }
  return "MONGODB_URI";
}

/**
 * Parse a comma-separated origin allowlist into exact-match origins.
 * Entries are trimmed, blanks dropped, and any trailing slash removed so
 * "https://x.app/" and "https://x.app" both match the browser's Origin header,
 * which never carries a trailing slash.
 */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Extract the database name from a Mongo connection string without exposing
 * credentials or host. Used by the health endpoint so operators can confirm
 * which environment they hit without the URI ever leaving the server.
 */
export function databaseNameFromUri(uri: string): string {
  try {
    // The mongodb+srv:// scheme parses fine under WHATWG URL.
    const path = new URL(uri).pathname.replace(/^\//, "");
    const name = path.split("?")[0];
    return name || "(default)";
  } catch {
    return "(unparseable)";
  }
}
