/**
 * Copies campaigns and deals into the consumer schema.
 *
 * Read-only against Mongo, always. This script moves history; it is not
 * permitted to modify the collections it reads and must never become the thing
 * that does.
 *
 * Re-runnable: every row upserts on its Mongo ObjectId hex.
 *
 * One thing worth stating plainly, because it is the whole reason the deal
 * table looks the way it does. `currentUses` is a cursor into `codes`, and a
 * claim is a compare-and-swap against its exact value. Copying it wrong does
 * not corrupt a display — it hands two people the same discount code, or
 * skips one nobody ever receives. So it is copied verbatim, never recomputed
 * from `claims.length`, and the two are reported when they disagree rather
 * than reconciled.
 *
 *   npm run db:backfill:deals -- --dry-run
 *   MONGODB_DB=mint-rewards-test npm run db:backfill:deals
 */
import { MongoClient, type Document } from "mongodb";
import pg from "pg";

const CAMPAIGN_STATUSES = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
]);
const DEAL_STATUSES = new Set([
  "pending",
  "active",
  "rejected",
  "inactive",
  "expired",
]);

const id = (value: unknown): string => String(value);

function text(value: unknown, fallback: string | null = null): string | null {
  if (value === null || value === undefined) return fallback;
  const asText = String(value);
  return asText.trim() === "" ? fallback : asText;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry));
}

function whole(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function when(value: unknown): Date {
  const date = value ? new Date(value as string) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
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

  try {
    await mongo.connect();
    const dbName = process.env.MONGODB_DB?.trim() || mongo.db().databaseName;
    const db = mongo.db(dbName);

    console.log(`source     ${dbName}`);
    console.log(`target     ${new URL(databaseUrl).host}/consumer`);
    console.log(`mode       ${dryRun ? "DRY RUN — nothing will be written" : "WRITE"}\n`);

    const run = async (sql: string, values: unknown[]) => {
      if (!dryRun) await pool.query(sql, values);
    };

    // --- Campaigns ---------------------------------------------------------
    const campaigns = await db.collection<Document>("campaigns").find().toArray();
    let campaignCount = 0;
    for (const doc of campaigns) {
      const status = String(doc.status ?? "PENDING");
      await run(
        `INSERT INTO consumer.campaigns
           (id, name, start_date, end_date, discount_codes, is_single_code,
            discount_percentage, addresses, status, users, brand, brand_id,
            brand_registration, description, campaign_type, target_audience,
            budget, background_color, badge, subtitle, banner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, start_date = EXCLUDED.start_date,
           end_date = EXCLUDED.end_date,
           discount_codes = EXCLUDED.discount_codes,
           is_single_code = EXCLUDED.is_single_code,
           discount_percentage = EXCLUDED.discount_percentage,
           addresses = EXCLUDED.addresses, status = EXCLUDED.status,
           users = EXCLUDED.users, brand = EXCLUDED.brand,
           brand_id = EXCLUDED.brand_id,
           brand_registration = EXCLUDED.brand_registration,
           description = EXCLUDED.description,
           campaign_type = EXCLUDED.campaign_type,
           target_audience = EXCLUDED.target_audience,
           budget = EXCLUDED.budget,
           background_color = EXCLUDED.background_color,
           badge = EXCLUDED.badge, subtitle = EXCLUDED.subtitle,
           banner = EXCLUDED.banner`,
        [
          id(doc._id),
          text(doc.name, "Untitled campaign"),
          text(doc.startDate),
          text(doc.endDate),
          stringArray(doc.discountCodes),
          doc.isSingleCode === true,
          text(doc.discountPercentage),
          JSON.stringify(doc.addresses ?? []),
          CAMPAIGN_STATUSES.has(status) ? status : "PENDING",
          stringArray(doc.users),
          id(doc.brand),
          // Not in CampaignSchema, so easy to miss — and 7 of 8 production
          // campaigns carry it. Dropping it unpairs a repointed campaign from
          // the brand card it should appear on.
          doc.brandId ? id(doc.brandId) : null,
          text(doc.brandRegistration, "") ?? "",
          text(doc.description),
          text(doc.campaignType),
          text(doc.targetAudience),
          whole(doc.budget),
          text(doc.backgroundColor),
          text(doc.badge),
          text(doc.subtitle),
          text(doc.banner),
        ],
      );
      campaignCount += 1;
    }
    console.log(`  campaigns  ${campaignCount}`);

    // --- Deals -------------------------------------------------------------
    const deals = await db.collection<Document>("deals").find().toArray();
    let dealCount = 0;
    for (const doc of deals) {
      const status = String(doc.status ?? "pending");
      const codes = stringArray(doc.codes);
      // Copied verbatim, never recomputed. See the note at the top of this
      // file: this number decides which code the next claimant is handed.
      const currentUses = whole(doc.currentUses) ?? 0;
      const claims = Array.isArray(doc.claims) ? doc.claims : [];

      if (currentUses !== claims.length) {
        notes.push(
          `deal ${id(doc._id)} — currentUses ${currentUses} but ${claims.length} claim(s); copied as-is`,
        );
      }
      if (currentUses > codes.length) {
        notes.push(
          `deal ${id(doc._id)} — currentUses ${currentUses} exceeds ${codes.length} code(s); the next claim will find nothing`,
        );
      }

      await run(
        `INSERT INTO consumer.deals
           (id, brand, title, description, discount_percentage, discount_amount,
            codes, promo_code, start_date, end_date, max_uses, current_uses,
            minimum_purchase, status, users, claims, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO UPDATE SET
           brand = EXCLUDED.brand, title = EXCLUDED.title,
           description = EXCLUDED.description,
           discount_percentage = EXCLUDED.discount_percentage,
           discount_amount = EXCLUDED.discount_amount,
           codes = EXCLUDED.codes, promo_code = EXCLUDED.promo_code,
           start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
           max_uses = EXCLUDED.max_uses, current_uses = EXCLUDED.current_uses,
           minimum_purchase = EXCLUDED.minimum_purchase,
           status = EXCLUDED.status, users = EXCLUDED.users,
           claims = EXCLUDED.claims, updated_at = EXCLUDED.updated_at`,
        [
          id(doc._id),
          id(doc.brand),
          text(doc.title, "Untitled deal"),
          text(doc.description, "") ?? "",
          whole(doc.discountPercentage),
          whole(doc.discountAmount),
          codes,
          text(doc.promoCode),
          text(doc.startDate),
          text(doc.endDate),
          whole(doc.maxUses),
          currentUses,
          whole(doc.minimumPurchase),
          DEAL_STATUSES.has(status) ? status : "pending",
          stringArray(doc.users),
          JSON.stringify(
            claims.map((claim: Document) => ({
              user: id(claim.user),
              code: String(claim.code ?? ""),
              claimedAt: when(claim.claimedAt).toISOString(),
            })),
          ),
          when(doc.createdAt),
          when(doc.updatedAt),
        ],
      );
      dealCount += 1;
    }
    console.log(`  deals      ${dealCount}`);

    if (notes.length > 0) {
      console.log(`\n  ${notes.length} row(s) worth a look:`);
      for (const line of notes.slice(0, 20)) console.log(`    ${line}`);
      if (notes.length > 20) console.log(`    ... and ${notes.length - 20} more`);
    }

    if (!dryRun) {
      const after = await pool.query<{ t: string; n: string }>(`
        SELECT 'campaigns' AS t, count(*)::text AS n FROM consumer.campaigns
        UNION ALL SELECT 'deals', count(*)::text FROM consumer.deals`);
      console.log("\n  rows now:");
      for (const row of after.rows) console.log(`    ${row.t.padEnd(12)} ${row.n}`);
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
