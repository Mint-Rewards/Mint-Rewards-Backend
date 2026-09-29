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

/**
 * Google project 490896222696.
 *
 * VERIFIED 2026-09-20 against the Cloud console: project 78392867949, named
 * above as the replacement, does NOT exist in the engineering-app-org
 * organisation (99488475543). All three IDs below are live, undeleted OAuth
 * clients in the "Mint Rewards App" project (project-b6c5b956-e219-40ca-994),
 * and two of them are exactly what GOOGLE_IOS_CLIENT_ID and
 * GOOGLE_WEB_CLIENT_ID are set to today.
 *
 * So do NOT action the "REMOVE THIS" instruction above without re-checking the
 * console first. Deleting this list as it stands would drop the auto-created
 * web client (…-kdpg…, created 2026-07-14) from the accepted audiences; the
 * other two survive only because the env vars happen to supply them.
 *
 * What actually changed on 2026-07-29/30 is unresolved — the production Vercel
 * client IDs were last modified on exactly those dates, but they are stored as
 * Secret-typed values and cannot be read back to confirm what they hold.
 */
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
