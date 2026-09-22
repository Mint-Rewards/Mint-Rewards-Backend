/**
 * Copies the `users` collection into consumer.users.
 *
 * Read-only against Mongo, always. This script moves accounts; it is not
 * permitted to modify the collection it reads and must never become the thing
 * that does.
 *
 * Re-runnable: every row upserts on its Mongo ObjectId hex, in batches.
 *
 * Three things here are not mechanical:
 *
 * `password`, `passwordReset` and `emailVerification` hold a bcrypt hash and
 * two OTP hashes. They are copied because an account without them cannot log
 * in or finish a reset, and nothing here prints them. The read goes through
 * the raw driver rather than the Mongoose model on purpose: the two OTP
 * blocks carry `select: false`, which the model honours by returning them as
 * undefined — copying through it would silently lock every half-finished
 * reset out.
 *
 * `profileBonusGrantedAt` is the idempotency key for the payout. Absent means
 * unpaid. It is copied as-is and never defaulted; inventing a value would mark
 * everyone paid, and dropping one would pay somebody twice.
 *
 * Coordinates are `[lng, lat]` and must be finite. The directory sync learned
 * this the hard way: values arrive as strings, as numbers, as nulls, and NaN
 * written into a geography column makes the row unusable for routing.
 *
 *   npm run db:backfill:users -- --dry-run
 *   MONGODB_DB=mint-rewards-test npm run db:backfill:users
 */
import { MongoClient, type Document } from "mongodb";
import pg from "pg";

const BATCH = 250;

const PRECISIONS = new Set(["building", "block", "area", "city", "unknown"]);
const SOURCES = new Set([
  "map_pin",
  "area_centroid",
  "city_centroid",
  "legacy_string",
  "collector_verified",
]);

const id = (value: unknown): string => String(value);

/** Mongo stored several of these as numbers. The column is text. */
function text(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function whole(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function real(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function when(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function json(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** `[lng, lat]`, or null when either is missing or not finite. */
function coordinates(doc: Document): [number, number] | null {
  const raw = doc.location?.coordinates;
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const lng = Number(raw[0]);
  const lat = Number(raw[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // Outside these a point is not on Earth, and PostGIS will accept it without
  // complaint — the directory would then route a captain to nowhere.
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return [lng, lat];
}

interface Counts {
  scanned: number;
  written: number;
  withCoordinate: number;
  withPasswordReset: number;
  withEmailVerification: number;
  bonusGranted: number;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const mongoUri = process.env.MONGODB_URI?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!mongoUri || !databaseUrl) {
    console.error("Both MONGODB_URI and DATABASE_URL must be set.");
    process.exit(1);
  }

  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 15_000 });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const notes: string[] = [];
  const counts: Counts = {
    scanned: 0,
    written: 0,
    withCoordinate: 0,
    withPasswordReset: 0,
    withEmailVerification: 0,
    bonusGranted: 0,
  };

  try {
    await mongo.connect();
    const dbName = process.env.MONGODB_DB?.trim() || mongo.db().databaseName;
    const db = mongo.db(dbName);

    console.log(`source     ${dbName}.users`);
    console.log(`target     ${new URL(databaseUrl).host}/consumer.users`);
    console.log(`mode       ${dryRun ? "DRY RUN — nothing will be written" : "WRITE"}\n`);

    const total = await db.collection("users").countDocuments();
    let batch: Document[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      if (!dryRun) {
        for (const doc of batch) {
          const coords = coordinates(doc);
          const precision = doc.location?.precision;
          const source = doc.location?.source;
          await pool.query(
            `INSERT INTO consumer.users (
               id, user_name, email, password, mint_id, role, phone, avatar,
               address, province, city, town, town_other, sub_area,
               sub_area_other, latitude, longitude, device_token, points,
               total_collections, total_waste_collected, referrals,
               referral_reward_granted,
               geog, precision, source, accuracy_meters, captured_at,
               structured_address, location_verification, location_version,
               location_completed_at, profile_bonus_window_started_at,
               profile_bonus_granted_at, profile_bonus_points, pickup_history,
               created, first_time_login, password_reset, email_verification,
               email_verified, apple_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                     $17,$18,$19,$20,$21,$22,$23,
                     CASE WHEN $24::double precision IS NULL THEN NULL
                          ELSE ST_SetSRID(ST_MakePoint($24, $25), 4326)::geography END,
                     $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
                     $40,$41,$42,$43)
             ON CONFLICT (id) DO UPDATE SET
               user_name = EXCLUDED.user_name, email = EXCLUDED.email,
               password = EXCLUDED.password, mint_id = EXCLUDED.mint_id,
               role = EXCLUDED.role, phone = EXCLUDED.phone,
               avatar = EXCLUDED.avatar, address = EXCLUDED.address,
               province = EXCLUDED.province, city = EXCLUDED.city,
               town = EXCLUDED.town, town_other = EXCLUDED.town_other,
               sub_area = EXCLUDED.sub_area,
               sub_area_other = EXCLUDED.sub_area_other,
               latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
               device_token = EXCLUDED.device_token, points = EXCLUDED.points,
               total_collections = EXCLUDED.total_collections,
               total_waste_collected = EXCLUDED.total_waste_collected,
               referrals = EXCLUDED.referrals,
               referral_reward_granted = EXCLUDED.referral_reward_granted,
               geog = EXCLUDED.geog, precision = EXCLUDED.precision,
               source = EXCLUDED.source,
               accuracy_meters = EXCLUDED.accuracy_meters,
               captured_at = EXCLUDED.captured_at,
               structured_address = EXCLUDED.structured_address,
               location_verification = EXCLUDED.location_verification,
               location_version = EXCLUDED.location_version,
               location_completed_at = EXCLUDED.location_completed_at,
               profile_bonus_window_started_at = EXCLUDED.profile_bonus_window_started_at,
               profile_bonus_granted_at = EXCLUDED.profile_bonus_granted_at,
               profile_bonus_points = EXCLUDED.profile_bonus_points,
               pickup_history = EXCLUDED.pickup_history,
               created = EXCLUDED.created,
               first_time_login = EXCLUDED.first_time_login,
               password_reset = EXCLUDED.password_reset,
               email_verification = EXCLUDED.email_verification,
               email_verified = EXCLUDED.email_verified,
               apple_id = EXCLUDED.apple_id`,
            [
              id(doc._id),
              text(doc.userName, "Unnamed"),
              text(doc.email).toLowerCase(),
              text(doc.password),
              text(doc.mintId) || `legacy-${id(doc._id)}`,
              text(doc.role, "MEMBER") || "MEMBER",
              text(doc.phone),
              text(doc.avatar),
              text(doc.address),
              text(doc.province),
              text(doc.city),
              text(doc.town),
              text(doc.townOther),
              text(doc.subArea),
              text(doc.subAreaOther),
              text(doc.latitude),
              text(doc.longitude),
              text(doc.deviceToken),
              whole(doc.points) ?? 0,
              text(doc.totalCollections),
              text(doc.totalWasteCollected),
              stringArray(doc.referrals),
              doc.referralRewardGranted === true,
              coords ? coords[0] : null,
              coords ? coords[1] : null,
              PRECISIONS.has(String(precision)) ? String(precision) : null,
              SOURCES.has(String(source)) ? String(source) : null,
              real(doc.location?.accuracyMeters),
              when(doc.location?.capturedAt),
              json(doc.structuredAddress),
              json(doc.locationVerification),
              whole(doc.locationVersion) ?? 0,
              when(doc.locationCompletedAt),
              when(doc.profileBonusWindowStartedAt),
              // Copied as-is. Absent means unpaid; inventing a value marks
              // everyone paid and dropping one pays somebody twice.
              when(doc.profileBonusGrantedAt),
              whole(doc.profileBonusPoints),
              json(doc.pickupHistory) ?? "[]",
              when(doc.created) ?? new Date(),
              doc.firstTimeLogin !== false,
              json(doc.passwordReset),
              json(doc.emailVerification),
              doc.emailVerified === true,
              doc.appleId ? text(doc.appleId) : null,
            ],
          );
          counts.written += 1;
        }
      }
      process.stdout.write(`\r  scanned ${counts.scanned}/${total}...`);
      batch = [];
    };

    // The raw driver, deliberately, not Mongoose. `select: false` on
    // passwordReset and emailVerification is a Mongoose projection default,
    // so reading through the model would return them as undefined and every
    // half-finished reset would be silently dropped. The driver has no such
    // notion and returns the documents whole.
    const cursor = db.collection("users").find({});

    for await (const doc of cursor) {
      counts.scanned += 1;
      if (coordinates(doc)) counts.withCoordinate += 1;
      if (doc.passwordReset) counts.withPasswordReset += 1;
      if (doc.emailVerification) counts.withEmailVerification += 1;
      if (doc.profileBonusGrantedAt) counts.bonusGranted += 1;
      if (!doc.email) {
        notes.push(`user ${id(doc._id)} — no email; it is a NOT NULL column`);
      }
      batch.push(doc);
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    console.log(`\n\nscanned                 ${counts.scanned}`);
    console.log(`written                 ${dryRun ? "(none — dry run)" : counts.written}`);
    console.log(`with a coordinate       ${counts.withCoordinate}`);
    console.log(`with a password reset   ${counts.withPasswordReset}`);
    console.log(`with an email OTP       ${counts.withEmailVerification}`);
    console.log(`profile bonus granted   ${counts.bonusGranted}`);

    if (notes.length > 0) {
      console.log(`\n  ${notes.length} row(s) needing attention:`);
      for (const line of notes.slice(0, 20)) console.log(`    ${line}`);
      if (notes.length > 20) console.log(`    ... and ${notes.length - 20} more`);
    }

    if (!dryRun) {
      const after = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM consumer.users",
      );
      console.log(`\nrows now                ${after.rows[0].n}`);
    }

    console.log(`\n${dryRun ? "Dry run complete. Nothing was written." : "Done."}`);
  } finally {
    await mongo.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error("\n" + (error instanceof Error ? error.message : error));
  process.exit(1);
});
