/**
 * Single source of environment truth for the Node runtime.
 *
 * Every required variable is parsed and validated once, at module load. A
 * misconfigured deployment fails immediately with ONE error naming EVERY
 * missing or malformed key, rather than surfacing as a 500 on whichever route
 * happens to be hit first.
 *
 * Deliberately dependency-free: this is a flat map of ~16 string keys, and
 * keeping it hand-rolled means no schema library ends up in the bundle.
 *
 * NOTE FOR middleware.ts: do not import this file. It throws at module load,
 * which in the middleware bundle would take down the entire /api/:path*
 * matcher on a single missing key. Middleware uses lib/edgeEnv.ts, which reads
 * the same variables but fails closed instead of throwing.
 */
import {
  isAppEnv,
  parseOrigins,
  databaseNameFromUri,
  resolveMongoUriKey,
  type AppEnv,
} from "@/lib/envShared";

type Problem = string;

const problems: Problem[] = [];

function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") {
    problems.push(`${key} is required but was not set`);
    return "";
  }
  return value.trim();
}

/**
 * Secrets short enough to brute-force are treated as malformed, not merely
 * present. A 4-character JWT_SECRET is a misconfiguration, and the whole point
 * of this file is to catch it at boot rather than in production traffic.
 */
function requiredSecret(key: string, minLength = 16): string {
  const value = required(key);
  if (value && value.length < minLength) {
    problems.push(
      `${key} is too short (${value.length} chars, minimum ${minLength})`,
    );
  }
  return value;
}

/**
 * Next's env loader performs shell-style `$VAR` expansion on .env values,
 * so a bcrypt hash must be written as `\$2b\$10\$...` there or it is eaten.
 * `dotenv` — which jest and the scripts/ CLIs use — does NOT unescape that,
 * so the same file yields a different string depending on who read it, and
 * bcrypt.compare() silently returns false against the escaped form.
 *
 * Normalising here means both loaders converge on the real hash.
 */
function unescapeDollars(value: string): string {
  return value.replace(/\\\$/g, "$");
}

function requiredMatching(key: string, pattern: RegExp, hint: string): string {
  const value = required(key);
  if (value && !pattern.test(value)) {
    problems.push(`${key} is malformed — expected ${hint}`);
  }
  return value;
}

/**
 * Required only outside production. Used for DEV_MAIL_REDIRECT_TO: a non-prod
 * deployment must not be able to boot without a mail sink configured, because
 * the alternative is silently emailing real users from a dev environment.
 * Production has no use for it and must not set it.
 */
function requiredUnlessProduction(
  key: string,
  appEnv: AppEnv,
  pattern: RegExp,
  hint: string,
): string | null {
  const value = process.env[key]?.trim();

  if (appEnv === "production") {
    if (value) {
      problems.push(
        `${key} must NOT be set when APP_ENV=production — it redirects all ` +
          `outbound mail away from real recipients`,
      );
    }
    return null;
  }

  if (!value) {
    problems.push(
      `${key} is required when APP_ENV is not "production" — non-production ` +
        `deployments must redirect all outbound mail to a sink address ` +
        `rather than emailing real users`,
    );
    return null;
  }
  if (!pattern.test(value)) {
    problems.push(`${key} is malformed — expected ${hint}`);
  }
  return value;
}

function requiredAppEnv(key: string): AppEnv {
  const value = process.env[key]?.trim();
  if (!isAppEnv(value)) {
    problems.push(
      `${key} is required and must be exactly "development" or "production"` +
        (value ? ` (got "${value}")` : ""),
    );
    // Fail closed while we accumulate the rest of the problems. This value is
    // never observed by callers — the throw below happens first.
    return "production";
  }
  return value;
}

function requiredOriginList(key: string): string[] {
  const origins = parseOrigins(process.env[key]);
  if (origins.length === 0) {
    problems.push(
      `${key} is required and must list at least one exact origin ` +
        `(comma-separated, e.g. "https://example.com,http://localhost:5173")`,
    );
    return [];
  }
  const malformed = origins.filter((o) => !/^https?:\/\/[^/\s]+$/.test(o));
  if (malformed.length > 0) {
    problems.push(
      `${key} contains malformed origins: ${malformed.join(", ")} — ` +
        `each entry must be scheme + host only, with no path`,
    );
  }
  return origins;
}

/**
 * Optional absolute https URL. Unset is legal; malformed is not.
 *
 * Used for the store links in /api/app-config. Unset is legal on purpose: the
 * mobile force-update gate treats a missing store URL for its platform as
 * "gate not armed" and fails open, which is strictly better than blocking the
 * app behind an Update button that leads nowhere.
 */
function optionalHttpsUrl(key: string): string | null {
  const value = process.env[key]?.trim();
  if (!value) return null;
  if (!/^https:\/\/[^/\s]+\//.test(value)) {
    problems.push(
      `${key} is malformed — expected an absolute https URL, got "${value}"`,
    );
  }
  return value;
}

/**
 * Optional semver string, defaulting to a value that gates nothing.
 *
 * The default matters more than it looks: this value decides whether installed
 * apps in the wild get hard-blocked. An unset or typo'd variable must mean
 * "block nobody" ("0.0.0"), never "block everybody" — a bad deploy here is not
 * recoverable from the client side, since the blocked app is the thing that
 * would have to fetch the fix.
 */
function optionalSemver(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    problems.push(
      `${key} is malformed — expected a bare semver like "2.1.8", got "${value}"`,
    );
    return fallback;
  }
  return value;
}

/** Optional non-negative integer, defaulting to a value that gates nothing. */
function optionalBuildNumber(key: string): number {
  const value = process.env[key]?.trim();
  if (!value) return 0;
  if (!/^\d+$/.test(value)) {
    problems.push(
      `${key} is malformed — expected a non-negative integer, got "${value}"`,
    );
    return 0;
  }
  return Number(value);
}

/** Optional boolean flag, accepting only "true"/"false". Defaults to false. */
function optionalBoolean(key: string): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return false;
  if (value !== "true" && value !== "false") {
    problems.push(`${key} must be exactly "true" or "false", got "${value}"`);
    return false;
  }
  return value === "true";
}

/**
 * Optional enum string. Unset returns `fallback`; a value outside `allowed`
 * fails fast (pushed to `problems`) rather than silently coercing to the
 * fallback — for LOCATION_GATE_MODE in particular, a typo must never resolve
 * to whichever state the fallback happens to be.
 */
function optionalEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  if (!allowed.includes(value as T)) {
    problems.push(
      `${key} must be one of ${allowed.join(", ")}, got "${value}"`,
    );
    return fallback;
  }
  return value as T;
}

/** Optional positive integer (>= 1), defaulting to `fallback` when unset. */
function optionalPositiveInt(key: string, fallback: number): number {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    problems.push(
      `${key} is malformed — expected a positive integer, got "${value}"`,
    );
    return fallback;
  }
  return Number(value);
}

/**
 * Optional opaque string secret. Unset returns null; no format validation —
 * used for third-party API keys whose shape is not ours to police. Unlike
 * `required`, a missing value here is not a boot failure: LOCATIONIQ_API_KEY
 * is the first user, and POST /api/location/reverse-geocode is written to
 * treat an unset key as "resolve nothing" rather than refuse to boot the
 * whole deployment over one unprovisioned third-party credential.
 */
function optionalString(key: string): string | null {
  const value = process.env[key]?.trim();
  return value || null;
}

/**
 * Optional non-negative integer build number, defaulting to null rather than
 * 0. Unlike optionalBuildNumber (used by the force-update gate, where 0 means
 * "gate nothing"), null here is the more honest "no minimum configured" —
 * the location gate's client-side resolution treats a null minClientBuild
 * entry as "do not build-gate this platform" rather than "block build < 0",
 * which 0 would ambiguously suggest.
 */
function optionalBuildNumberOrNull(key: string): number | null {
  const value = process.env[key]?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    problems.push(
      `${key} is malformed — expected a non-negative integer, got "${value}"`,
    );
    return null;
  }
  return Number(value);
}

// --- Parse ------------------------------------------------------------------

const APP_ENV = requiredAppEnv("APP_ENV");

// Reported in the boot error and by databaseName(), so a misconfiguration
// names the variable that actually supplied the URI.
const MONGODB_URI_KEY = resolveMongoUriKey(
  APP_ENV,
  process.env.MONGODB_URI_TEST,
);

const parsed = {
  APP_ENV,
  isProduction: APP_ENV === "production",

  // Database. In development this resolves to MONGODB_URI_TEST when one is
  // set — see resolveMongoUriKey in lib/envShared.ts.
  mongodbUriKey: MONGODB_URI_KEY,
  mongodbUri: requiredMatching(
    MONGODB_URI_KEY,
    /^mongodb(\+srv)?:\/\//,
    'a connection string starting with "mongodb://" or "mongodb+srv://"',
  ),

  // Consumer-app JWT. Signing algorithm and payload shape are unchanged —
  // this only collapses the previous JWT_SECRET -> NEXTAUTH_SECRET ->
  // NEXT_JWT_SECRET lookup chain down to one key.
  jwtSecret: requiredSecret("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || "7d",

  // BrandHub (separate secret by design — see lib/brandJwt.ts)
  brandhubJwtSecret: requiredSecret("BRANDHUB_JWT_SECRET"),

  // Global admin
  adminJwtSecret: requiredSecret("ADMIN_JWT_SECRET"),
  adminEmail: requiredMatching(
    "ADMIN_EMAIL",
    /^[^@\s]+@[^@\s]+$/,
    "an email address",
  ),
  adminPasswordHash: unescapeDollars(
    requiredMatching(
      "ADMIN_PASSWORD_HASH",
      /^\\?\$2[aby]\\?\$/,
      "a bcrypt hash (starts with $2a$ / $2b$ / $2y$)",
    ),
  ),

  // OTP peppering. Previously fell back through the JWT secrets to "" — an
  // empty HMAC key, which made stored OTP hashes trivially reversible.
  otpPepper: requiredSecret("OTP_PEPPER"),

  // Identity providers
  googleIosClientId: required("GOOGLE_IOS_CLIENT_ID"),
  googleWebClientId: required("GOOGLE_WEB_CLIENT_ID"),
  appleBundleId: required("APPLE_BUNDLE_ID"),

  // Email
  resendApiKey: required("RESEND_API_KEY"),
  emailFrom: required("EMAIL_FROM"),

  // Referral email download link. A UA-sniffing redirect that forwards to the
  // right store, intended to live on mintrewards.app. That route does not
  // exist yet, so unset is the expected state today and the referral template
  // falls back to offering both stores side by side rather than guessing one.
  appDownloadUrl: optionalHttpsUrl("APP_DOWNLOAD_URL"),

  // Public origin of this backend, used to build absolute links that land in
  // email — today, the unsubscribe link in the referral template. Defaults to
  // the production deployment, which is the same host the CI smoke test pings,
  // so an unset variable produces a link that works rather than one that
  // points at localhost.
  publicBaseUrl:
    optionalHttpsUrl("PUBLIC_BASE_URL") ??
    "https://mint-rewards-backend.vercel.app/",

  // Signing secret for the Resend webhook (Svix format, "whsec_..."). Optional
  // on purpose: making it required would take every existing deployment down
  // at boot before the webhook is registered in the Resend dashboard. The
  // route fails closed instead — unset means it rejects every delivery rather
  // than trusting unsigned input.
  resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET?.trim() || null,

  // Physical mailing address for email footers. Required by anti-spam law in
  // most of the jurisdictions this sends into, and until it is set the
  // templates render a visible placeholder rather than silently omitting it.
  emailPostalAddress:
    process.env.EMAIL_POSTAL_ADDRESS?.trim() || "[TODO: postal address]",

  // Non-production mail sink. Every outbound message is rewritten to this
  // address regardless of its real recipient — see emailServices/emailFunction.
  // null in production, and lib/env.ts rejects the key being set there at all.
  devMailRedirectTo: requiredUnlessProduction(
    "DEV_MAIL_REDIRECT_TO",
    APP_ENV,
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    "a single email address",
  ),

  // Storage
  blobReadWriteToken: required("BLOB_PUBLIC_READ_WRITE_TOKEN"),

  // CORS
  allowedOrigins: requiredOriginList("ALLOWED_ORIGINS"),

  // Mobile force-update gate, served by /api/app-config. Every key here is
  // optional and defaults to "gates nothing" — see optionalSemver above for
  // why the safe default points that way.
  //
  // On build numbers: eas.json sets `appVersionSource: "remote"`, so build
  // numbers are assigned by EAS rather than edited in the repo, and they
  // increment on every production build while `version` stays put for weeks.
  // That makes the build number the finer-grained and ultimately more reliable
  // gate of the two — "block anything before build 21" is expressible, "block
  // some of 2.1.8 but not all of it" is not. The field is wired end-to-end now
  // so that switching to it later is an env-var change, not a release.
  appConfig: {
    minSupportedVersion: optionalSemver("MIN_SUPPORTED_APP_VERSION", "0.0.0"),
    minSupportedBuildNumber: {
      ios: optionalBuildNumber("MIN_SUPPORTED_BUILD_IOS"),
      android: optionalBuildNumber("MIN_SUPPORTED_BUILD_ANDROID"),
    },
    iosStoreUrl: optionalHttpsUrl("IOS_STORE_URL"),
    androidStoreUrl: optionalHttpsUrl("ANDROID_STORE_URL"),
    forceOTA: optionalBoolean("FORCE_OTA_UPDATE"),

    // Location-capture gate config, also served by /api/app-config. The
    // server only serves these values — the resolution order (e.g. "a build
    // below minClientBuild forces the gate to at least soft regardless of
    // mode") is CLIENT logic, applied by the mobile app against whatever it
    // reads here. Keeping that logic out of the backend means tuning it is
    // a client release, not a server deploy, and the server never needs to
    // know the client's own version/build to decide anything.
    locationGate: {
      // "soft" MUST remain the deployed default until 2.1.10 store adoption
      // is high enough to justify "hard" — see .env.example.
      mode: optionalEnum(
        "LOCATION_GATE_MODE",
        ["hard", "soft", "off"] as const,
        "soft",
      ),
      activatedCitiesOnly: optionalBoolean(
        "LOCATION_GATE_ACTIVATED_CITIES_ONLY",
      ),
      maxDismissals: optionalPositiveInt("LOCATION_GATE_MAX_DISMISSALS", 3),
      minClientBuild: {
        ios: optionalBuildNumberOrNull("LOCATION_GATE_MIN_BUILD_IOS"),
        android: optionalBuildNumberOrNull("LOCATION_GATE_MIN_BUILD_ANDROID"),
      },
    },
  },

  // Reverse-geocoding (P1.1: POST /api/location/reverse-geocode). Deliberately
  // NOT inside appConfig above — that object is served verbatim by
  // /api/app-config to every mobile client, and this is a server-side secret
  // that must never appear in a response body. Optional: an unset key makes
  // the route answer `{ resolved: false }` for every request without ever
  // fetching or caching, rather than failing the whole deployment to boot.
  locationIqApiKey: optionalString("LOCATIONIQ_API_KEY"),

  // Deployment metadata — genuinely optional, absent outside Vercel.
  commitSha: process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
} as const;

// --- Fail fast --------------------------------------------------------------

if (problems.length > 0) {
  throw new Error(
    `Invalid environment configuration (${problems.length} problem${
      problems.length === 1 ? "" : "s"
    }):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\nSee .env.example for the full list of required keys.`,
  );
}

export const serverEnv = Object.freeze(parsed);
export type ServerEnv = typeof serverEnv;

export { APP_ENV };
export type { AppEnv };

/** Resolved database name, safe to expose. Never returns the full URI. */
export function databaseName(): string {
  return databaseNameFromUri(serverEnv.mongodbUri);
}

/** Prefix every log line with the environment that produced it. */
export function logPrefix(scope: string): string {
  return `[${APP_ENV}][${scope}]`;
}

export default serverEnv;
