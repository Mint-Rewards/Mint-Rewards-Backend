/**
 * Which Google OAuth clients this backend will accept ID tokens from.
 *
 * On 2026-07-29/30 the app and this backend moved to Google project
 * 78392867949. The move replaced the accepted audience rather than extending
 * it, so every binary built before that date — Android 2.1.5 (built Jul 23)
 * and iOS 2.1.7 build 48 and earlier — still mints tokens for the old project
 * and now fails verification with "Wrong recipient, payload audience !=
 * requiredAudience". The user sees a flat "Invalid token".
 *
 * That is unrecoverable from the user's side: accounts created through Google
 * have a random password (see the google route), so there is no other way in,
 * and an app store update is exactly the thing a locked-out user has no reason
 * to go looking for.
 *
 * Accepting the old audiences costs nothing security-wise. Google's signature
 * check is unchanged; every client ID below is one we own, and all of them
 * already ship inside published binaries — they are public identifiers, not
 * secrets.
 *
 * REMOVE THIS once the old versions have drained from the field. Check store
 * analytics for active installs of Android < 2.1.7 and iOS build <= 48; when
 * that reaches zero, delete this file's LEGACY list and the spread in the
 * google route.
 */

/** Google project 490896222696 — superseded 2026-07-29/30. */
export const LEGACY_GOOGLE_AUDIENCES: readonly string[] = [
  // iOS client, every build up to and including iOS 2.1.7 build 48.
  "490896222696-4jtrnrbi9uhn98q2ukjb68f2cd45dq2v.apps.googleusercontent.com",
  // Web client (Android's audience) as of app commit 780904b, 2026-07-22.
  "490896222696-3umgevhg0eqtkg03cfs7saa19i0g8qir.apps.googleusercontent.com",
  // The web client that 780904b replaced — still live in installs older than that.
  "490896222696-kdpgcfnhh860ilahd091n09vnh2f3avs.apps.googleusercontent.com",
];

/**
 * The full audience list to hand to `verifyIdToken`: the current clients
 * first, then the superseded ones. Deduplicated so that re-pointing an env var
 * at a legacy ID cannot produce a duplicate entry.
 */
export function googleAudiences(
  currentIosClientId: string,
  currentWebClientId: string,
): string[] {
  return Array.from(
    new Set([
      currentIosClientId,
      currentWebClientId,
      ...LEGACY_GOOGLE_AUDIENCES,
    ]),
  );
}
