import { NextRequest, NextResponse } from "next/server";
import { createLog, findLogs } from "@/lib/repositories/logs";
import { requireAdminAuth } from "@/lib/requireAdminAuth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const { event, deviceId, platform, appVersion, buildNumber } = body;
    if (!event || !deviceId || !platform || !appVersion || !buildNumber) {
      return NextResponse.json(
        { error: "Missing required fields." },
        { status: 400 },
      );
    }

    await createLog({
      ...body,
      timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    console.error("[Logs] Failed to save:", error);
    // Always 201 — never let logging break the app
    return NextResponse.json({ ok: true }, { status: 201 });
  }
}

export async function GET(req: NextRequest) {
  const auth = requireAdminAuth(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const logs = await findLogs({
      userId: searchParams.get("userId") ?? undefined,
      event: searchParams.get("event") ?? undefined,
      route: searchParams.get("route") ?? undefined,
      level: searchParams.get("level") ?? undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });

    return NextResponse.json({ logs, total: logs.length });
  } catch {
    return NextResponse.json(
      { error: "Failed to retrieve logs." },
      { status: 500 },
    );
  }
}
