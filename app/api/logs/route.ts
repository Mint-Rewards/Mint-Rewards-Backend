import { NextRequest, NextResponse } from "next/server";
import { Log } from "@/lib/models";
import connectToDatabase from "@/lib/mongodb";

export async function POST(req: NextRequest) {
  try {
    await connectToDatabase();
    const body = await req.json();

    const { event, deviceId, platform, appVersion, buildNumber } = body;
    if (!event || !deviceId || !platform || !appVersion || !buildNumber) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }

    await Log.create({
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
  try {
    await connectToDatabase();
    const { searchParams } = new URL(req.url);

    const filter: Record<string, unknown> = {};
    const userId = searchParams.get("userId");
    const event = searchParams.get("event");
    const route = searchParams.get("route");
    const level = searchParams.get("level");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    if (userId) filter.userId = userId;
    if (event) filter.event = event;
    if (route) filter.route = route;
    if (level) filter.level = level;
    if (from || to) {
      filter.timestamp = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }

    const logs = await Log.find(filter)
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();

    return NextResponse.json({ logs, total: logs.length });
  } catch (error) {
    return NextResponse.json({ error: "Failed to retrieve logs." }, { status: 500 });
  }
}