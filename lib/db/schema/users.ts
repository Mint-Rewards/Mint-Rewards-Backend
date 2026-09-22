/**
 * Consumer accounts — the last model off Mongo, and the one everything else
 * points at.
 *
 * Shaped so the admin API's `public.user_directory` can become a view over
 * this table rather than a synced copy: `geog`, `precision`, `source`,
 * `location_version`, `mint_id`, `phone`, `email` and `email_verified` are
 * named and typed to match it. That projection exists because users lived in
 * a different store; once they do not, the sync job is deleted.
 *
 * Two things here are security properties, not conveniences:
 *
 * `password_reset` and `email_verification` hold OTP hashes and carried
 * `select: false` in Mongoose, so they never left the database through an
 * ordinary read. Postgres has no such flag — `SELECT *` returns everything —
 * so the repository must project columns explicitly and only include these
 * when a caller asks. See lib/repositories/users.ts.
 *
 * `profile_bonus_granted_at` is the idempotency key for the payout. The claim
 * filters on it being absent, which is what makes a concurrent second call
 * match nothing. It has no default and must never acquire one: a value on
 * every row from creation means the filter matches nobody and the bonus is
 * never paid.
 */
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { consumer } from "./logs";

/**
 * PostGIS geography, matching user_directory.geog.
 *
 * Declared as a custom type because drizzle has no native one; the column is
 * written and read through ST_ functions in raw SQL either way.
 */
const geography = customType<{ data: string; driverData: string }>({
  dataType: () => "geography(Point,4326)",
});

export const users = consumer.table(
  "users",
  {
    id: text("id").primaryKey(),

    userName: text("user_name").notNull(),
    email: text("email").notNull(),
    /** bcrypt hash. Never projected by the default read. */
    password: text("password").notNull(),
    mintId: text("mint_id").notNull(),
    role: text("role").notNull().default("MEMBER"),
    phone: text("phone").notNull().default(""),
    avatar: text("avatar").notNull().default(""),

    // ---- Legacy address strings ------------------------------------------
    // Unchanged and still dual-written; the structured fields below have not
    // replaced them for every reader yet.
    address: text("address").notNull().default(""),
    province: text("province").notNull().default(""),
    city: text("city").notNull().default(""),
    town: text("town").notNull().default(""),
    townOther: text("town_other").notNull().default(""),
    subArea: text("sub_area").notNull().default(""),
    subAreaOther: text("sub_area_other").notNull().default(""),
    /** Strings, as Mongo held them — often "" and occasionally unparseable. */
    latitude: text("latitude").notNull().default(""),
    longitude: text("longitude").notNull().default(""),

    deviceToken: text("device_token").notNull().default(""),
    points: integer("points").notNull().default(0),
    totalCollections: text("total_collections").notNull().default(""),
    totalWasteCollected: text("total_waste_collected").notNull().default(""),

    /**
     * Every address this user has referred.
     *
     * Unbounded in Mongo, where it counted against the 16MB document cap. It
     * does not here — a text[] column has no such ceiling — so the caveat in
     * the old schema no longer applies, though the data is still never pruned.
     */
    referrals: text("referrals").array().notNull().default(sql`'{}'`),
    referralRewardGranted: boolean("referral_reward_granted")
      .notNull()
      .default(false),

    // ---- Structured location ---------------------------------------------
    /** [lng, lat] as PostGIS geography — the same column user_directory has. */
    geog: geography("geog"),
    /**
     * Anything other than "building" is excluded from routing: every user on
     * a centroid shares one coordinate, which clusters but cannot get a
     * collector to a door.
     */
    locationPrecision: text("precision"),
    locationSource: text("source"),
    locationAccuracyMeters: doublePrecision("accuracy_meters"),
    locationCapturedAt: timestamp("captured_at", { withTimezone: true }),

    /**
     * Canonical registry values, where the keys ARE the display names —
     * `cityId` holds "Karachi", not a slug.
     */
    structuredAddress: jsonb("structured_address"),

    /**
     * The geocoder's answer beside the user's, and how they differed.
     *
     * Kept whole rather than split into columns: every row where
     * `geocodedAreaRaw` and `selectedAreaId` disagree is a labelled geocoder
     * failure at a known coordinate, which is training data for the
     * gazetteer. Nothing here may collapse those two together.
     */
    locationVerification: jsonb("location_verification"),

    locationVersion: integer("location_version").notNull().default(0),
    locationCompletedAt: timestamp("location_completed_at", {
      withTimezone: true,
    }),

    // ---- Profile-completion bonus ----------------------------------------
    // All three are server-stamped and must never be client-writable: a user
    // who can write granted_at decides whether they have been paid, and one
    // who can write window_started_at restarts their own 24-hour window.
    profileBonusWindowStartedAt: timestamp("profile_bonus_window_started_at", {
      withTimezone: true,
    }),
    /** Presence is the idempotency key. No default, ever. */
    profileBonusGrantedAt: timestamp("profile_bonus_granted_at", {
      withTimezone: true,
    }),
    profileBonusPoints: integer("profile_bonus_points"),

    /** Address snapshots frozen at pickup creation. Read whole. */
    pickupHistory: jsonb("pickup_history").notNull().default(sql`'[]'::jsonb`),

    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    firstTimeLogin: boolean("first_time_login").notNull().default(true),

    /** OTP hashes. Never in the default projection — see the file header. */
    passwordReset: jsonb("password_reset"),
    emailVerification: jsonb("email_verification"),

    emailVerified: boolean("email_verified").notNull().default(false),
    appleId: text("apple_id"),
  },
  (table) => [
    uniqueIndex("users_email_key").on(table.email),
    uniqueIndex("users_mint_id_key").on(table.mintId),
    // Sparse in Mongo: only accounts that linked Apple have one, and many
    // nulls must not collide with each other.
    uniqueIndex("users_apple_id_key")
      .on(table.appleId)
      .where(sql`${table.appleId} IS NOT NULL`),
    index("users_email_verified_idx").on(table.emailVerified),
    index("users_location_version_idx").on(table.locationVersion),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
