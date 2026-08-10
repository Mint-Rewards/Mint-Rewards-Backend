import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env";

// Deliberately a Next App Router `route.ts` and NOT an entry in the Express
// layer under app/api/*.ts. Vercel serves the Next build, where only
// `<dir>/route.ts` is a route — /api/health once 404'd in production for
// exactly this reason while its Express-backed jest test passed. See the
// comment in app/api/health/route.ts.
//
// force-dynamic for the same reason health does it: this payload is the kill
// switch for every installed app, and a prerendered constant would mean
// raising the minimum version has no effect until the next deploy.
export const dynamic = "force-dynamic";

/**
 * Public app configuration for the mobile client's force-update gate.
 *
 * Unauthenticated by design — the client calls this before login, and in the
 * blocking case the user cannot log in at all until they update. middleware.ts
 * only applies CORS over /api/:path*, so there is no auth to opt out of; this
 * comment exists so nobody later "fixes" the missing auth check.
 *
 * Nothing here is a secret: it is five deployment-tuning values that ship in
 * every app binary's request path anyway.
 */
export async function GET() {
  const {
    minSupportedVersion,
    minSupportedBuildNumber,
    iosStoreUrl,
    androidStoreUrl,
    forceOTA,
  } = serverEnv.appConfig;

  return NextResponse.json({
    minSupportedVersion,
    minSupportedBuildNumber,
    // Null when unset rather than "" — the client treats a missing store URL
    // for its own platform as "gate not armed" and fails open, so the absent
    // case has to be unambiguous on the wire.
    iosStoreUrl,
    androidStoreUrl,
    forceOTA,
  });
}
