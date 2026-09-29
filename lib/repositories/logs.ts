/**
 * Where client telemetry is read and written, during the migration off Mongo.
 *
 * Postgres is authoritative wherever it is configured; Mongo answers only when
 * it is not. Deliberately not a dual write: two stores accepting the same
 * record means two ways for it to half-succeed, and telemetry is not worth
 * that. A deployment moves when its DATABASE_URL appears, and the backfill
 * script carries the history across.
 *
 * The route above this knows none of that. That is the point of the file —
 * the next model to move gets the same shape, and the cutover is one constant.
 */
import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { getDb, isPostgresConfigured } from "@/lib/postgres";
import { logs, type NewLogRow } from "@/lib/db/schema";
import { Log } from "@/lib/models";
import connectToDatabase from "@/lib/mongodb";

export interface LogInput {
  event: string;
  level?: string;
  userId?: string;
  userEmail?: string;
  route?: string;
  previousRoute?: string;
  deviceId: string;
  deviceModel?: string;
  platform: string;
  appVersion: string;
  buildNumber: string;
  timestamp: Date;
  extra?: Record<string, unknown>;
}

export interface LogFilter {
  userId?: string;
  event?: string;
  route?: string;
  level?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/** What the dashboard renders. Identical from either store. */
export interface LogRecord {
  event: string;
  level: string;
  userId: string | null;
  userEmail: string | null;
  route: string | null;
  previousRoute: string | null;
  deviceId: string;
  deviceModel: string;
  platform: string;
  appVersion: string;
  buildNumber: string;
  timestamp: string;
  extra: Record<string, unknown> | null;
}

const DEFAULT_LIMIT = 100;

/** The only levels the column's CHECK constraint accepts. */
const LEVELS = ["info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

/**
 * Mongo accepted any string here despite the schema's enum, so rows exist
 * that Postgres' CHECK would reject. Coercing rather than failing keeps a
 * malformed level from costing the event itself, which is the more useful
 * half of the record.
 */
function normaliseLevel(level: string | undefined): Level {
  const value = (level ?? "info").toLowerCase();
  return (LEVELS as readonly string[]).includes(value)
    ? (value as Level)
    : "info";
}

export function toRow(input: LogInput): NewLogRow {
  return {
    event: input.event,
    level: normaliseLevel(input.level),
    userId: input.userId ?? null,
    userEmail: input.userEmail ?? null,
    route: input.route ?? null,
    previousRoute: input.previousRoute ?? null,
    deviceId: input.deviceId,
    deviceModel: input.deviceModel || "unknown",
    platform: input.platform,
    appVersion: input.appVersion,
    buildNumber: input.buildNumber,
    timestamp: input.timestamp,
    extra: input.extra ?? null,
  };
}

/** True when this deployment's telemetry goes to Postgres. */
export function logsAreOnPostgres(): boolean {
  return isPostgresConfigured();
}

export async function createLog(input: LogInput): Promise<void> {
  if (logsAreOnPostgres()) {
    await getDb().insert(logs).values(toRow(input));
    return;
  }
  await connectToDatabase();
  await Log.create({ ...input, level: normaliseLevel(input.level) });
}

export function buildConditions(filter: LogFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.userId) conditions.push(eq(logs.userId, filter.userId));
  if (filter.event) conditions.push(eq(logs.event, filter.event));
  if (filter.route) conditions.push(eq(logs.route, filter.route));
  if (filter.level) conditions.push(eq(logs.level, filter.level));
  if (filter.from) conditions.push(gte(logs.timestamp, filter.from));
  if (filter.to) conditions.push(lte(logs.timestamp, filter.to));
  return conditions;
}

export async function findLogs(filter: LogFilter): Promise<LogRecord[]> {
  const limit = filter.limit ?? DEFAULT_LIMIT;

  if (logsAreOnPostgres()) {
    const conditions = buildConditions(filter);
    const rows = await getDb()
      .select()
      .from(logs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(logs.timestamp))
      .limit(limit);

    return rows.map((row) => ({
      event: row.event,
      level: row.level,
      userId: row.userId,
      userEmail: row.userEmail,
      route: row.route,
      previousRoute: row.previousRoute,
      deviceId: row.deviceId,
      deviceModel: row.deviceModel,
      platform: row.platform,
      appVersion: row.appVersion,
      buildNumber: row.buildNumber,
      timestamp: row.timestamp.toISOString(),
      extra: (row.extra as Record<string, unknown> | null) ?? null,
    }));
  }

  await connectToDatabase();
  const mongoFilter: Record<string, unknown> = {};
  if (filter.userId) mongoFilter.userId = filter.userId;
  if (filter.event) mongoFilter.event = filter.event;
  if (filter.route) mongoFilter.route = filter.route;
  if (filter.level) mongoFilter.level = filter.level;
  if (filter.from || filter.to) {
    mongoFilter.timestamp = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lte: filter.to } : {}),
    };
  }

  const docs = await Log.find(mongoFilter)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();

  return docs.map((doc) => ({
    event: doc.event,
    level: doc.level ?? "info",
    userId: doc.userId ?? null,
    userEmail: doc.userEmail ?? null,
    route: doc.route ?? null,
    previousRoute: doc.previousRoute ?? null,
    deviceId: doc.deviceId,
    deviceModel: doc.deviceModel ?? "unknown",
    platform: doc.platform,
    appVersion: doc.appVersion,
    buildNumber: doc.buildNumber,
    timestamp: new Date(doc.timestamp).toISOString(),
    extra: (doc.extra as Record<string, unknown> | undefined) ?? null,
  }));
}
