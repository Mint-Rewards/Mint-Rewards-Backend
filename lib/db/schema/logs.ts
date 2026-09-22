/**
 * Client telemetry, the first model moved off Mongo.
 *
 * Chosen to go first because it is append-only, nothing reads it on a request
 * path, and one route touches it — so the port exercises the schema, backfill
 * and cutover pattern without being able to hurt anyone if the pattern is
 * wrong.
 *
 * `timestamp` is the client's clock, not the server's, and is trusted no
 * further than that: it is what the dashboard sorts by, because an event's
 * own time is what an investigator is asking about, but it can be skewed or
 * absent. `received_at` is the server's own record, and is what retention
 * measures against for exactly that reason.
 */
import {
  bigserial,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The consumer backend's own schema, inside the database the admin API
 * already uses.
 *
 * Not `public`: the admin API owns that, and it has `captains` and
 * `collections` tables while this codebase has models of the same names that
 * are not obviously the same things. Sharing one schema would force that
 * question to be answered by a name collision at migration time. One database
 * still means a view can span both, which is how `user_directory` is meant to
 * collapse once `users` moves.
 */
export const consumer = pgSchema("consumer");

export const logs = consumer.table(
  "logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),

    event: text("event").notNull(),
    // Not a pg enum: Mongo stored this as a free string with an application
    // -level enum, and a database enum would reject rows the old store
    // accepted. A CHECK constraint lives in the migration instead, which can
    // be relaxed without a type rewrite.
    level: text("level").notNull().default("info"),

    // Optional so pre-auth events are still captured — someone crashing on
    // the login screen is exactly who you want telemetry about.
    userId: text("user_id"),
    userEmail: text("user_email"),

    route: text("route"),
    previousRoute: text("previous_route"),

    deviceId: text("device_id").notNull(),
    deviceModel: text("device_model").notNull().default("unknown"),
    platform: text("platform").notNull(),
    appVersion: text("app_version").notNull(),
    buildNumber: text("build_number").notNull(),

    /** The client's clock. Sorted by, not trusted. */
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    /** The server's clock. What retention measures. */
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    extra: jsonb("extra"),
  },
  (table) => [
    // The three compound indexes carried over from Mongo, which are the
    // dashboard's actual queries: one subject, most recent first.
    index("logs_user_id_timestamp_idx").on(
      table.userId,
      table.timestamp.desc(),
    ),
    index("logs_event_timestamp_idx").on(table.event, table.timestamp.desc()),
    index("logs_device_id_timestamp_idx").on(
      table.deviceId,
      table.timestamp.desc(),
    ),
    // Filter-only columns. The dashboard narrows by these before sorting.
    index("logs_route_idx").on(table.route),
    index("logs_level_idx").on(table.level),
    // Retention sweeps by arrival, so it gets its own index rather than
    // sharing the client-clock one.
    index("logs_received_at_idx").on(table.receivedAt),
  ],
);

export type LogRow = typeof logs.$inferSelect;
export type NewLogRow = typeof logs.$inferInsert;
