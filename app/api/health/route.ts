import { NextResponse } from "next/server";

// The Express router in app/api/health.ts serves this same payload to jest via
// app.ts, but Vercel serves the Next build, where only `<dir>/route.ts` is a
// route — so /api/health 404'd in production while health.test.ts passed. This
// file is what backend-ci's smoke test and the ZAP scan actually hit.
//
// force-dynamic keeps the handler off the prerender path: a build-time
// timestamp would make the response a cached constant, and a health check that
// can be served from cache tells you nothing about the running deployment.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
