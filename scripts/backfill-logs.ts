/**
 * Copies the `logs` collection into consumer.logs.
 *
 * Read-only against Mongo, always. This script moves history so that cutting a
 * deployment over to Postgres does not make its past disappear; it is not
 * permitted to modify the collection it reads, and must never become the thing
 * that does.
 *
 * Re-runnable. Progress is tracked by the newest client timestamp already in
 * Postgres, so a second run copies only what arrived since the first. That is
 * a watermark rather than a per-row identity: Mongo's _id does not survive
 * into a bigserial, and matching on one would mean carrying an index purely
 * for a migration.
 *
 *   npm run db:backfill:logs -- --dry-run
 *   npm run db:backfill:logs
 *   MONGODB_DB=mint-rewards-test npm run db:backfill:logs
 */
import { MongoClient, type Document } from "mongodb";
import pg from "pg";

const BATCH = 500;

interface MongoLog extends Document {
  event?: string;
  level?: string;
  userId?: string;
  userEmail?: string;
  route?: string;
  previousRoute?: string;
  deviceId?: string;
  deviceModel?: string;
  platform?: string;
  appVersion?: string;
  buildNumber?: string;
  timestamp?: Date | string;
  extra?: unknown;
}

const LEVELS = new Set(["info", "warn", "error"]);

/** Mongo accepted any string despite the schema's enum; the CHECK will not. */
function level(value: string | undefined): string {
  const lowered = (value ?? "info").toLowerCase();
  return LEVELS.has(lowered) ? lowered : "info";
}

function text(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
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

  try {
    await mongo.connect();
    // Explicit rather than inherited from the URI: this cluster has eight
    // databases and none of them is named for its environment, so the one
    // being read is worth stating out loud before anything is copied.
    const dbName = process.env.MONGODB_DB?.trim() || mongo.db().databaseName;
    const collection = mongo.db(dbName).collection<MongoLog>("logs");

    const { rows } = await pool.query<{ watermark: Date | null }>(
      "SELECT max(timestamp) AS watermark FROM consumer.logs",
    );
    const watermark = rows[0]?.watermark ?? null;
    const filter = watermark ? { timestamp: { $gt: watermark } } : {};

    const total = await collection.countDocuments(filter);
    console.log(`source     ${dbName}.logs`);
    console.log(`target     ${new URL(databaseUrl).host}/consumer.logs`);
    console.log(`mode       ${dryRun ? "DRY RUN — nothing will be written" : "WRITE"}`);
    console.log(`watermark  ${watermark ? watermark.toISOString() : "none — copying everything"}`);
    console.log(`to copy    ${total}\n`);

    if (total === 0) {
      console.log("Nothing to copy.");
      return;
    }

    let copied = 0;
    let skipped = 0;
    let batch: MongoLog[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      const usable = batch.filter(
        (doc) => doc.event && doc.deviceId && doc.timestamp,
      );
      skipped += batch.length - usable.length;

      if (!dryRun && usable.length > 0) {
        const values: unknown[] = [];
        const tuples = usable.map((doc, i) => {
          const b = i * 13;
          values.push(
            text(doc.event),
            level(doc.level),
            doc.userId ? text(doc.userId) : null,
            doc.userEmail ? text(doc.userEmail) : null,
            doc.route ? text(doc.route) : null,
            doc.previousRoute ? text(doc.previousRoute) : null,
            text(doc.deviceId),
            text(doc.deviceModel, "unknown") || "unknown",
            text(doc.platform, "unknown") || "unknown",
            text(doc.appVersion, "unknown") || "unknown",
            text(doc.buildNumber, "unknown") || "unknown",
            new Date(doc.timestamp as Date),
            doc.extra === undefined ? null : JSON.stringify(doc.extra),
          );
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`;
        });
        await pool.query(
          `INSERT INTO consumer.logs
             (event, level, user_id, user_email, route, previous_route,
              device_id, device_model, platform, app_version, build_number,
              timestamp, extra)
           VALUES ${tuples.join(",")}`,
          values,
        );
      }
      copied += usable.length;
      process.stdout.write(`\r  copied ${copied}/${total}...`);
      batch = [];
    };

    const cursor = collection.find(filter).sort({ timestamp: 1 });
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    const after = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM consumer.logs",
    );
    console.log(`\n\ncopied     ${copied}`);
    console.log(
      `skipped    ${skipped}${skipped ? " (missing event, deviceId or timestamp)" : ""}`,
    );
    console.log(`rows now   ${after.rows[0].n}`);
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
