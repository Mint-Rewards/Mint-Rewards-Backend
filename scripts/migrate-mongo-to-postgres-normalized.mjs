#!/usr/bin/env node
// One-time MongoDB -> Postgres migration into the NORMALIZED target schema
// (docs/postgres-schema-proposal.dbml / scripts/postgres-normalized-schema.sql).
//
// Unlike scripts/migrate-mongo-to-postgres.mjs (which dumps each collection
// into one table 1:1, jsonb-ing anything that doesn't fit), this script
// decomposes the denormalized arrays/sub-documents into real child tables —
// see the schema file's table Notes for what maps to what. Because that
// decomposition needs per-field logic the vendored mongo-to-postgres tool
// can't express (multi-target ID remapping, flattening nested objects,
// merging two source sub-schemas into one discriminated table), this talks
// to Mongo and Postgres directly rather than going through vendor/.
//
// BEFORE RUNNING: create the target schema —
//   psql "$POSTGRES_URL_TEST" -f scripts/postgres-normalized-schema.sql
//
// Hard-locked to TEST databases (MONGODB_URI_TEST / POSTGRES_URL_TEST), same
// guard as the rehearsal script. Not idempotent — re-run schema.sql (or
// truncate) between attempts.
//
// Usage: node scripts/migrate-mongo-to-postgres-normalized.mjs --yes
//
// Anything that can't be migrated cleanly (an orphaned ObjectId ref, a claim
// code that was never issued, an unparseable date) is logged as a WARNING
// and skipped rather than aborting the run — the point of running this
// against real data is to surface exactly those cases. See the summary
// printed at the end.

import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import pg from "pg";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const MONGODB_URI_TEST = process.env.MONGODB_URI_TEST;
const POSTGRES_URL_TEST = process.env.POSTGRES_URL_TEST;

if (!MONGODB_URI_TEST) {
  console.error(
    "MONGODB_URI_TEST is not set — define it in .env (see .env.example).",
  );
  process.exit(1);
}
if (!POSTGRES_URL_TEST) {
  console.error(
    "POSTGRES_URL_TEST is not set — define it in .env (see .env.example).",
  );
  process.exit(1);
}

const looksLikeTestUri = (uri) => /(^|[-_/])test(?=[-_/?]|$)/i.test(uri);
for (const [name, uri] of [
  ["MONGODB_URI_TEST", MONGODB_URI_TEST],
  ["POSTGRES_URL_TEST", POSTGRES_URL_TEST],
]) {
  if (!looksLikeTestUri(uri)) {
    console.error(
      `Refusing to run: ${name} does not look like a test database URI ` +
        `(expected "test" to appear in the db name). This script is ` +
        `hard-locked to test databases — check the value in .env.`,
    );
    process.exit(1);
  }
}

function redact(uri) {
  return uri.replace(/\/\/[^@]+@/, "//<redacted>@");
}

if (!process.argv.includes("--yes")) {
  console.log(
    "Dry run only. This would migrate into the normalized schema from " +
      `${redact(MONGODB_URI_TEST)} to ${redact(POSTGRES_URL_TEST)}.\n` +
      "Every insert is permanent and this is not idempotent — make sure " +
      "the target tables are empty (scripts/postgres-normalized-schema.sql).\n" +
      "Pass --yes to actually run it.",
  );
  process.exit(0);
}

const oidStr = (v) => (v === undefined || v === null ? null : v.toString());

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.warn(`  ! ${msg}`);
}

// Guards against structural shape drift: a field the ETL assumes is an
// array/sub-document being *present* with the wrong type in a legacy
// document. `?? []` / `?.` alone only handle the field being absent or
// null — a present-but-wrong-type value (e.g. a string where an array is
// expected) would otherwise iterate char-by-char (strings are iterable)
// or read every nested property as silently `undefined`, corrupting or
// dropping data with no warning. These normalize to the empty/absent case
// AND log a warning so the anomaly shows up in the run summary.
function asArray(value, label) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  warn(`${label}: expected an array, got ${typeof value} (${JSON.stringify(value).slice(0, 80)}) — treating as empty.`);
  return [];
}

function asObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  warn(`${label}: expected an object, got ${typeof value} (${JSON.stringify(value).slice(0, 80)}) — treating as absent.`);
  return {};
}

// Columns whose value is `undefined` OR `null` in the source doc are
// OMITTED from the INSERT entirely, so a NOT NULL DEFAULT '...' column in
// the target schema gets its default instead of failing the constraint.
// Found against real data: some documents (written by a direct-DB script
// bypassing the Mongoose `stringDefaultEmpty` default) have explicit
// `null` where Mongoose's own default would have produced `""` — e.g.
// users.latitude/longitude, which are NOT NULL DEFAULT '' in Postgres.
// Every NOT NULL DEFAULT column in this schema is paired with a default
// (none are nullable-with-a-default), so treating null like undefined
// doesn't change outcomes for genuinely nullable columns — omitting still
// yields Postgres's own implicit NULL there, same as passing null did.
function presentEntries(row) {
  return Object.entries(row).filter(([, v]) => v !== undefined && v !== null);
}

async function insertReturningId(client, table, row) {
  const entries = presentEntries(row);
  const columns = entries.map(([c]) => c);
  const values = entries.map(([, v]) => v);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders}) RETURNING id`;
  const { rows } = await client.query(sql, values);
  return rows[0].id;
}

async function insertRow(client, table, row, { onConflictDoNothing = false } = {}) {
  const entries = presentEntries(row);
  const columns = entries.map(([c]) => c);
  const values = entries.map(([, v]) => v);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const conflict = onConflictDoNothing ? " ON CONFLICT DO NOTHING" : "";
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})${conflict}`;
  await client.query(sql, values);
}

async function main() {
  const mongo = new MongoClient(MONGODB_URI_TEST);
  const pgClient = new pg.Client({ connectionString: POSTGRES_URL_TEST });

  await mongo.connect();
  await pgClient.connect();
  const db = mongo.db();

  // Sets, not Maps. With the Mongo ObjectId as the Postgres primary key there
  // is nothing left to REMAP — an id is the same value in both databases. What
  // these still do, and must keep doing, is answer "does this document exist?"
  // so an orphaned reference is warned about and skipped rather than inserted
  // as a dangling FK (which the constraint would reject, aborting the run).
  const known = {
    organizations: new Set(),
    users: new Set(),
    brands: new Set(),
    campaigns: new Set(),
    deals: new Set(),
    brandusers: new Set(),
  };

  // Resolves a reference to the id to store, or undefined when the target does
  // not exist. Every caller's `=== undefined` orphan check works unchanged.
  const ref = (set, oid) => (set.has(oid) ? oid : undefined);


  const counts = {};
  const bump = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  console.log("Migrating organizations...");
  for (const doc of await db.collection("organizations").find().toArray()) {
    const id = oidStr(doc._id);
    await insertRow(pgClient, "organizations", {
      id: id,
      name: doc.name,
      plan: doc.plan ?? "starter",
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    known.organizations.add(id);
    bump("organizations");
    for (const sub of asArray(doc.moduleSubscriptions, `organizations/${doc._id}.moduleSubscriptions`)) {
      await insertRow(pgClient, "organization_module_subscriptions", {
        org_id: id,
        module: sub.module,
        status: sub.status,
        activated_at: sub.activatedAt,
        expires_at: sub.expiresAt,
      });
      bump("organization_module_subscriptions");
    }
  }

  console.log("Migrating brandthemes...");
  for (const doc of await db.collection("brandthemes").find().toArray()) {
    await insertRow(pgClient, "brandthemes", {
      id: oidStr(doc._id),
      name: doc.name,
      logo: doc.logo,
      background_color: doc.backgroundColor,
      accent_color: doc.accentColor,
      status: doc.status,
    });
    bump("brandthemes");
  }

  console.log("Migrating locations / cities / towns...");
  for (const doc of await db.collection("locations").find().toArray()) {
    const locationId = oidStr(doc._id);
    await insertRow(pgClient, "locations", {
      id: locationId,
      province: doc.province,
    });
    bump("locations");
    for (const city of asArray(doc.cities, `locations/${doc._id}.cities`)) {
      const cityId = await insertReturningId(pgClient, "cities", {
        location_id: locationId,
        name: city.name,
      });
      bump("cities");
      for (const townName of asArray(city.towns, `locations/${doc._id}.cities[].towns`)) {
        await insertRow(pgClient, "towns", { city_id: cityId, name: townName });
        bump("towns");
      }
    }
  }

  console.log("Migrating users...");
  for (const doc of await db.collection("users").find().toArray()) {
    const id = oidStr(doc._id);
    await insertRow(pgClient, "users", {
      id: id,
      user_name: doc.userName,
      email: doc.email,
      password: doc.password,
      avatar: doc.avatar,
      address: doc.address,
      province: doc.province,
      city: doc.city,
      town: doc.town,
      town_other: doc.townOther,
      sub_area: doc.subArea,
      sub_area_other: doc.subAreaOther,
      phone: doc.phone,
      mint_id: doc.mintId,
      role: doc.role,
      latitude: doc.latitude,
      longitude: doc.longitude,
      device_token: doc.deviceToken,
      points: doc.points,
      total_collections: doc.totalCollections,
      total_waste_collected: doc.totalWasteCollected,
      referral_reward_granted: doc.referralRewardGranted,
      profile_bonus_window_started_at: doc.profileBonusWindowStartedAt,
      profile_bonus_granted_at: doc.profileBonusGrantedAt,
      profile_bonus_points: doc.profileBonusPoints,
      created: doc.created,
      first_time_login: doc.firstTimeLogin,
      email_verified: doc.emailVerified,
      apple_id: doc.appleId,
    });
    known.users.add(id);
    bump("users");

    const loc = asObject(doc.location, `users/${doc._id}.location`);
    const addr = asObject(doc.structuredAddress, `users/${doc._id}.structuredAddress`);
    const ver = asObject(doc.locationVerification, `users/${doc._id}.locationVerification`);
    const hasLocationData =
      doc.location || doc.structuredAddress || doc.locationVerification ||
      doc.locationCompletedAt || (doc.locationVersion ?? 0) > 0;
    if (hasLocationData) {
      await insertRow(pgClient, "user_locations", {
        user_id: id,
        lng: loc.coordinates?.[0],
        lat: loc.coordinates?.[1],
        source: loc.source,
        precision: loc.precision,
        accuracy_meters: loc.accuracyMeters,
        captured_at: loc.capturedAt,
        structured_city_id: addr.cityId,
        structured_area_id: addr.areaId,
        structured_block_id: addr.blockId,
        structured_area_other: addr.areaOther,
        structured_block_other: addr.blockOther,
        structured_house_no: addr.houseNo,
        structured_street_or_block: addr.streetOrBlock,
        version: doc.locationVersion ?? 0,
        completed_at: doc.locationCompletedAt,
        verification_status: ver.status,
        verification_method: ver.method,
        verification_geocoded_area_raw: ver.geocodedAreaRaw,
        verification_geocoded_area_id: ver.geocodedAreaId,
        verification_selected_area_id: ver.selectedAreaId,
        verification_distance_meters: ver.distanceMeters,
        verification_checked_at: ver.checkedAt,
        verification_resolved_by: ver.resolvedBy,
      });
      bump("user_locations");
    }

    if (doc.passwordReset) {
      const pr = asObject(doc.passwordReset, `users/${doc._id}.passwordReset`);
      await insertRow(pgClient, "user_otp_flows", {
        user_id: id,
        purpose: "password_reset",
        otp_hash: pr.otpHash,
        expires_at: pr.expiresAt,
        attempts: pr.attempts ?? 0,
        last_sent_at: pr.lastSentAt,
      });
      bump("user_otp_flows");
    }
    if (doc.emailVerification) {
      const ev = asObject(doc.emailVerification, `users/${doc._id}.emailVerification`);
      await insertRow(pgClient, "user_otp_flows", {
        user_id: id,
        purpose: "email_verification",
        otp_hash: ev.otpHash,
        expires_at: ev.expiresAt,
        attempts: ev.attempts ?? 0,
        last_sent_at: ev.lastSentAt,
      });
      bump("user_otp_flows");
    }

    for (const address of asArray(doc.referrals, `users/${doc._id}.referrals`)) {
      await insertRow(
        pgClient,
        "user_referrals",
        { user_id: id, address, created_at: null },
        { onConflictDoNothing: true },
      );
      bump("user_referrals");
    }
  }

  console.log("Migrating logistics...");
  for (const doc of await db.collection("logistics").find().toArray()) {
    await insertRow(pgClient, "logistics", {
      id: oidStr(doc._id),
      name: doc.name,
      phone: doc.phone,
      email: doc.email,
      password: doc.password,
      avatar: doc.avatar,
      role: doc.role,
      device_token: doc.deviceToken,
      created: doc.created,
      email_verified: doc.emailVerified,
      verification_token: doc.verificationToken,
    });
    bump("logistics");
  }

  console.log("Migrating brands (pass 1: rows, legacy_brand_id deferred)...");
  const pendingLegacyRefs = []; // { id, legacyBrandId }
  for (const doc of await db.collection("brands").find().toArray()) {
    const id = oidStr(doc._id);
    await insertRow(pgClient, "brands", {
      id: id,
      org_id: doc.orgId ? ref(known.organizations, oidStr(doc.orgId)) : null,
      legacy_brand_id: null,
      company_name: doc.companyName,
      brand_name: doc.brandName,
      email: doc.email,
      logo: doc.logo,
      theme_image: doc.themeImage,
      category: doc.category,
      description: doc.description,
      address: doc.address,
      web_link: doc.webLink,
      app_link: doc.appLink,
      contact_name: doc.contactName,
      phone: doc.phone,
      registration_number: doc.registrationNumber,
      domain: doc.domain,
      theme_color: doc.themeColor,
      status: doc.status,
      role: doc.role,
      email_verified: doc.emailVerified,
      verification_token: doc.verificationToken,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    known.brands.add(id);
    bump("brands");
    if (doc.legacyBrandId) {
      pendingLegacyRefs.push({ id, legacyBrandId: oidStr(doc.legacyBrandId) });
    }

    if (doc.environmentalStats) {
      const stats = asObject(doc.environmentalStats, `brands/${doc._id}.environmentalStats`);
      const statId = await insertReturningId(pgClient, "brand_environmental_stats", {
        brand_id: id,
        is_snapshot: true,
        period_start: null,
        period_end: null,
        total_waste_kg: stats.totalWasteKg,
        co2_avoided_kg: stats.co2AvoidedKg,
      });
      bump("brand_environmental_stats");
      for (const mb of asArray(stats.materialBreakdown, `brands/${doc._id}.environmentalStats.materialBreakdown`)) {
        await insertRow(pgClient, "brand_environmental_material_breakdown", {
          stat_id: statId,
          material: mb.material,
          weight_kg: mb.weightKg,
        });
        bump("brand_environmental_material_breakdown");
      }
    }
    for (const [periodIdx, period] of asArray(doc.environmentalPeriods, `brands/${doc._id}.environmentalPeriods`).entries()) {
      const statId = await insertReturningId(pgClient, "brand_environmental_stats", {
        brand_id: id,
        is_snapshot: false,
        period_start: period.periodStart,
        period_end: period.periodEnd,
        total_waste_kg: period.totalWasteKg,
        co2_avoided_kg: period.co2AvoidedKg,
      });
      bump("brand_environmental_stats");
      for (const mb of asArray(period.materialBreakdown, `brands/${doc._id}.environmentalPeriods[${periodIdx}].materialBreakdown`)) {
        await insertRow(pgClient, "brand_environmental_material_breakdown", {
          stat_id: statId,
          material: mb.material,
          weight_kg: mb.weightKg,
        });
        bump("brand_environmental_material_breakdown");
      }
    }
  }

  console.log("Migrating brands (pass 2: resolving legacy_brand_id)...");
  for (const { id, legacyBrandId } of pendingLegacyRefs) {
    const resolved = ref(known.brands, legacyBrandId);
    if (resolved === undefined) {
      warn(
        `brands.id=${id}: legacyBrandId ${legacyBrandId} does not resolve to any migrated brand — leaving NULL.`,
      );
      continue;
    }
    await pgClient.query(`UPDATE "brands" SET "legacy_brand_id" = $1 WHERE "id" = $2`, [
      resolved,
      id,
    ]);
  }

  console.log("Migrating campaigns...");
  for (const doc of await db.collection("campaigns").find().toArray()) {
    const brandId = ref(known.brands, oidStr(doc.brand));
    if (brandId === undefined) {
      warn(`campaigns "${doc.name}" (${doc._id}): brand ${doc.brand} not found — skipping campaign.`);
      continue;
    }
    const id = oidStr(doc._id);
    await insertRow(pgClient, "campaigns", {
      id: id,
      name: doc.name,
      start_date: doc.startDate,
      end_date: doc.endDate,
      is_single_code: doc.isSingleCode ?? false,
      discount_percentage: doc.discountPercentage,
      status: doc.status,
      brand_id: brandId,
      brand_registration: doc.brandRegistration,
      description: doc.description,
      campaign_type: doc.campaignType,
      target_audience: doc.targetAudience,
      budget: doc.budget,
      background_color: doc.backgroundColor,
      badge: doc.badge,
      subtitle: doc.subtitle,
      banner: doc.banner,
    });
    known.campaigns.add(id);
    bump("campaigns");

    for (const code of asArray(doc.discountCodes, `campaigns/${doc._id}.discountCodes`)) {
      await insertRow(
        pgClient,
        "campaign_discount_codes",
        { campaign_id: id, code, is_used: false, used_by_user_id: null, used_at: null },
        { onConflictDoNothing: true },
      );
      bump("campaign_discount_codes");
    }
    for (const a of asArray(doc.addresses, `campaigns/${doc._id}.addresses`)) {
      await insertRow(pgClient, "campaign_addresses", {
        campaign_id: id,
        province: a.province,
        city: a.city,
        town: a.town,
      });
      bump("campaign_addresses");
    }
    for (const userRef of asArray(doc.users, `campaigns/${doc._id}.users`)) {
      const userId = ref(known.users, oidStr(userRef));
      if (userId === undefined) {
        warn(`campaign ${doc._id}: user ${userRef} not found — skipping campaign_users row.`);
        continue;
      }
      await insertRow(pgClient, "campaign_users", { campaign_id: id, user_id: userId });
      bump("campaign_users");
    }
  }

  console.log("Migrating deals...");
  for (const doc of await db.collection("deals").find().toArray()) {
    const brandId = ref(known.brands, oidStr(doc.brand));
    if (brandId === undefined) {
      warn(`deal "${doc.title}" (${doc._id}): brand ${doc.brand} not found — skipping deal.`);
      continue;
    }
    const id = oidStr(doc._id);
    await insertRow(pgClient, "deals", {
      id: id,
      brand_id: brandId,
      title: doc.title,
      description: doc.description,
      discount_percentage: doc.discountPercentage,
      discount_amount: doc.discountAmount,
      start_date: doc.startDate,
      end_date: doc.endDate,
      max_uses: doc.maxUses,
      current_uses: doc.currentUses,
      minimum_purchase: doc.minimumPurchase,
      status: doc.status,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    known.deals.add(id);
    bump("deals");

    const issuedCodes = new Set();
    for (const code of asArray(doc.codes, `deals/${doc._id}.codes`)) {
      await insertRow(
        pgClient,
        "deal_codes",
        { deal_id: id, code, is_used: false },
        { onConflictDoNothing: true },
      );
      issuedCodes.add(code);
      bump("deal_codes");
    }
    for (const userRef of asArray(doc.users, `deals/${doc._id}.users`)) {
      const userId = ref(known.users, oidStr(userRef));
      if (userId === undefined) {
        warn(`deal ${doc._id}: user ${userRef} not found — skipping deal_users row.`);
        continue;
      }
      await insertRow(pgClient, "deal_users", { deal_id: id, user_id: userId });
      bump("deal_users");
    }
    for (const claim of asArray(doc.claims, `deals/${doc._id}.claims`)) {
      const userId = ref(known.users, oidStr(claim.user));
      if (userId === undefined) {
        warn(`deal ${doc._id}: claim user ${claim.user} not found — skipping deal_claims row.`);
        continue;
      }
      if (!issuedCodes.has(claim.code)) {
        warn(
          `deal ${doc._id}: claim code "${claim.code}" is not in deals.codes[] — the ` +
            `deal_claims->deal_codes composite FK would reject this row. Skipping.`,
        );
        continue;
      }
      await insertRow(pgClient, "deal_claims", {
        deal_id: id,
        user_id: userId,
        code: claim.code,
        claimed_at: claim.claimedAt,
      });
      bump("deal_claims");
    }
  }

  console.log("Migrating brandusers...");
  for (const doc of await db.collection("brandusers").find().toArray()) {
    const orgId = ref(known.organizations, oidStr(doc.orgId));
    if (orgId === undefined) {
      warn(`branduser "${doc.email}" (${doc._id}): org ${doc.orgId} not found — skipping.`);
      continue;
    }
    const id = oidStr(doc._id);
    await insertRow(pgClient, "brandusers", {
      id: id,
      org_id: orgId,
      email: doc.email,
      password_hash: doc.passwordHash,
      org_role: doc.orgRole,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    known.brandusers.add(id);
    bump("brandusers");

    for (const ma of asArray(doc.moduleAccess, `brandusers/${doc._id}.moduleAccess`)) {
      for (const permission of asArray(ma.permissions, `brandusers/${doc._id}.moduleAccess[].permissions`)) {
        await insertRow(
          pgClient,
          "brand_user_module_access",
          { brand_user_id: id, module: ma.module, permission },
          { onConflictDoNothing: true },
        );
        bump("brand_user_module_access");
      }
    }
  }


  await mongo.close();
  await pgClient.end();

  console.log("\n=== Row counts ===");
  for (const [table, n] of Object.entries(counts).sort()) {
    console.log(`  ${table}: ${n}`);
  }
  console.log(`\n=== Warnings (${warnings.length}) ===`);
  if (warnings.length === 0) console.log("  none");
  for (const w of warnings) console.log(`  - ${w}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
