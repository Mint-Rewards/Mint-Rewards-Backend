/**
 * Environment access for the middleware bundle ONLY.
 *
 * middleware.ts cannot import lib/env.ts: that module throws at load time, and
 * in the middleware bundle a throw takes down the entire /api/:path* matcher —
 * turning one missing key into a total API outage. This module reads the same
 * variables and never throws.
 *
 * Failure mode is closed, not open:
 *   - a missing/invalid APP_ENV resolves to "production" (the stricter side)
 *   - a missing ALLOWED_ORIGINS resolves to [] — no browser origin is allowed
 *
 * lib/env.ts still enforces both keys as required, so a deployment missing
 * them fails loudly on the first route request. This file only guarantees the
 * failure is a CORS rejection rather than a crashed middleware chain.
 */
import { isAppEnv, parseOrigins, type AppEnv } from "@/lib/envShared";

const rawAppEnv = process.env.APP_ENV?.trim();

export const EDGE_APP_ENV: AppEnv = isAppEnv(rawAppEnv)
  ? rawAppEnv
  : "production";

export const EDGE_ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  parseOrigins(process.env.ALLOWED_ORIGINS),
);
