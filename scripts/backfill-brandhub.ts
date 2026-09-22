/**
 * Copies organizations, brandusers and brands into the consumer schema.
 *
 * Read-only against Mongo, always. This script moves history; it is not
 * permitted to modify the collections it reads and must never become the thing
 * that does.
 *
 * Order is forced: organizations first, because brand_users.org_id and
 * brands.org_id are foreign keys to it. A brand whose org was never migrated
 * would be rejected by the constraint rather than silently orphaned, which is
 * the point of having the constraint.
 *
 * Re-runnable. Every row upserts on its primary key -- the Mongo ObjectId hex
 * -- so a second run refreshes rather than duplicates, and a run interrupted
 * halfway can simply be repeated.
 *
 *   npm run db:backfill:brandhub -- --dry-run
 *   MONGODB_DB=mint-rewards-test npm run db:backfill:brandhub
 */
import { MongoClient, type Document } from "mongodb";
import pg from "pg";

const BATCH = 200;

const PLANS = new Set(["starter", "growth", "enterprise"]);
const STATUSES = new Set(["PENDING", "APPROVED", "REJECTED"]);

function id(value: unknown): string {
  return String(value);
}

function text(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  const asText = String(value);
  return asText.trim() === "" ? fallback : asText;
}

function json(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

function when(value: unknown): Date {
  const date = value ? new Date(value as string) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

interface Counts {
  organizations: number;
  brandUsers: number;
  brands: number;
  skipped: string[];
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
  const counts: Counts = {
    organizations: 0,
    brandUsers: 0,
    brands: 0,
    skipped: [],
  };

  try {
    await mongo.connect();
    // Stated out loud before anything is copied: this cluster has eight
    // databases and none is named for its environment.
    const dbName = process.env.MONGODB_DB?.trim() || mongo.db().databaseName;
    const db = mongo.db(dbName);

    console.log(`source     ${dbName}`);
    console.log(`target     ${new URL(databaseUrl).host}/consumer`);
    console.log(`mode       ${dryRun ? "DRY RUN — nothing will be written" : "WRITE"}\n`);

    const run = async (sql: string, values: unknown[]) => {
      if (!dryRun) await pool.query(sql, values);
    };

    // 1. Organizations. Must land before anything referencing them.
    const orgs = await db.collection<Document>("organizations").find().toArray();
    const orgIds = new Set<string>();
    for (const doc of orgs) {
      const plan = text(doc.plan, "starter");
      await run(
        `INSERT INTO consumer.organizations
           (id, name, plan, module_subscriptions, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, plan = EXCLUDED.plan,
           module_subscriptions = EXCLUDED.module_subscriptions,
           updated_at = EXCLUDED.updated_at`,
        [
          id(doc._id),
          text(doc.name, "Unnamed organisation"),
          PLANS.has(plan) ? plan : "starter",
          json(doc.moduleSubscriptions, "[]"),
          when(doc.createdAt),
          when(doc.updatedAt),
        ],
      );
      orgIds.add(id(doc._id));
      counts.organizations += 1;
    }
    console.log(`  organizations  ${counts.organizations}`);

    // 2. Brand users. org_id is NOT NULL, so one without a migrated org
    //    cannot be written at all — recorded rather than dropped quietly.
    const users = await db.collection<Document>("brandusers").find().toArray();
    for (const doc of users) {
      const orgId = id(doc.orgId);
      if (!orgIds.has(orgId)) {
        counts.skipped.push(`brand_user ${id(doc._id)} — org ${orgId} not migrated`);
        continue;
      }
      await run(
        `INSERT INTO consumer.brand_users
           (id, org_id, email, password_hash, org_role, module_access,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           org_id = EXCLUDED.org_id, email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash, org_role = EXCLUDED.org_role,
           module_access = EXCLUDED.module_access,
           updated_at = EXCLUDED.updated_at`,
        [
          id(doc._id),
          orgId,
          text(doc.email).toLowerCase(),
          text(doc.passwordHash),
          text(doc.orgRole, "member"),
          json(doc.moduleAccess, "[]"),
          when(doc.createdAt),
          when(doc.updatedAt),
        ],
      );
      counts.brandUsers += 1;
    }
    console.log(`  brand_users    ${counts.brandUsers}`);

    // 3. Brands. org_id is nullable here — legacy brands predate
    //    organisations — but a non-null one pointing nowhere is dropped to
    //    null rather than failing the row, since the brand itself is real.
    const brands = await db.collection<Document>("brands").find().toArray();
    let batch = 0;
    for (const doc of brands) {
      const orgId = doc.orgId ? id(doc.orgId) : null;
      const resolved = orgId && orgIds.has(orgId) ? orgId : null;
      if (orgId && !resolved) {
        counts.skipped.push(`brand ${id(doc._id)} — org ${orgId} not migrated, org_id set null`);
      }
      const status = text(doc.status, "PENDING");
      await run(
        `INSERT INTO consumer.brands
           (id, org_id, legacy_brand_id, company_name, brand_name, email, logo,
            theme_image, category, description, address, web_link, app_link,
            contact_name, phone, registration_number, domain, theme_color,
            status, role, email_verified, verification_token,
            environmental_stats, environmental_periods, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (id) DO UPDATE SET
           org_id = EXCLUDED.org_id, legacy_brand_id = EXCLUDED.legacy_brand_id,
           company_name = EXCLUDED.company_name, brand_name = EXCLUDED.brand_name,
           email = EXCLUDED.email, logo = EXCLUDED.logo,
           theme_image = EXCLUDED.theme_image, category = EXCLUDED.category,
           description = EXCLUDED.description, address = EXCLUDED.address,
           web_link = EXCLUDED.web_link, app_link = EXCLUDED.app_link,
           contact_name = EXCLUDED.contact_name, phone = EXCLUDED.phone,
           registration_number = EXCLUDED.registration_number,
           domain = EXCLUDED.domain, theme_color = EXCLUDED.theme_color,
           status = EXCLUDED.status, role = EXCLUDED.role,
           email_verified = EXCLUDED.email_verified,
           verification_token = EXCLUDED.verification_token,
           environmental_stats = EXCLUDED.environmental_stats,
           environmental_periods = EXCLUDED.environmental_periods,
           updated_at = EXCLUDED.updated_at`,
        [
          id(doc._id),
          resolved,
          doc.legacyBrandId ? id(doc.legacyBrandId) : null,
          text(doc.companyName, "Unknown"),
          text(doc.brandName, "Unknown"),
          text(doc.email).toLowerCase(),
          doc.logo ? text(doc.logo) : null,
          doc.themeImage ? text(doc.themeImage) : null,
          text(doc.category, "uncategorised"),
          text(doc.description),
          text(doc.address),
          text(doc.webLink, "https://example.invalid"),
          text(doc.appLink),
          text(doc.contactName, "Unknown"),
          text(doc.phone),
          text(doc.registrationNumber, `legacy-${id(doc._id)}`),
          text(doc.domain),
          text(doc.themeColor, "#3B82F6"),
          STATUSES.has(status) ? status : "PENDING",
          text(doc.role, "BRAND"),
          doc.emailVerified === true,
          doc.verificationToken ? text(doc.verificationToken) : null,
          doc.environmentalStats ? json(doc.environmentalStats, "null") : null,
          doc.environmentalPeriods ? json(doc.environmentalPeriods, "null") : null,
          when(doc.createdAt),
          when(doc.updatedAt),
        ],
      );
      counts.brands += 1;
      if (++batch % BATCH === 0) process.stdout.write(`\r  brands ${batch}...`);
    }
    console.log(`  brands         ${counts.brands}`);

    if (counts.skipped.length > 0) {
      console.log(`\n  ${counts.skipped.length} row(s) needed attention:`);
      for (const line of counts.skipped.slice(0, 20)) console.log(`    ${line}`);
      if (counts.skipped.length > 20) {
        console.log(`    ... and ${counts.skipped.length - 20} more`);
      }
    }

    if (!dryRun) {
      const after = await pool.query<{ t: string; n: string }>(`
        SELECT 'organizations' AS t, count(*)::text AS n FROM consumer.organizations
        UNION ALL SELECT 'brand_users', count(*)::text FROM consumer.brand_users
        UNION ALL SELECT 'brands', count(*)::text FROM consumer.brands`);
      console.log("\n  rows now:");
      for (const row of after.rows) console.log(`    ${row.t.padEnd(15)} ${row.n}`);
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
