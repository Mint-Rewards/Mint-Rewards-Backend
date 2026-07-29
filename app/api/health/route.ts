import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { APP_ENV, serverEnv, databaseName } from "@/lib/env";

/**
 * GET /api/health
 *
 * Confirms which deployment you are actually talking to. Reports the resolved
 * database NAME only — never the connection string, host, or credentials.
 *
 * Does not dial the database: it reports mongoose's existing connection state,
 * so a cold instance answers "disconnected" rather than opening a connection
 * as a side effect of a health probe.
 */
export const dynamic = "force-dynamic";

const READY_STATE: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

export async function GET() {
  const readyState = mongoose.connection.readyState;

  return NextResponse.json({
    status: "ok",
    environment: APP_ENV,
    database: {
      name: databaseName(),
      status: READY_STATE[readyState] ?? "unknown",
    },
    commit: serverEnv.commitSha,
    timestamp: new Date().toISOString(),
  });
}
