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

// Columns whose value is `undefined` in the source doc are OMITTED from the
// INSERT entirely (not passed as explicit NULL), so a NOT NULL DEFAULT '...'
// column in the target schema gets its default instead of failing the
// constraint. Explicit `null` (a field genuinely absent/cleared in Mongo,
// e.g. an optional sub-document) still inserts NULL, which is correct for
// nullable columns.
function presentEntries(row) {
  return Object.entries(row).filter(([, v]) => v !== undefined);
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

  const idMaps = {
    organizations: new Map(),
    users: new Map(),
    captains: new Map(),
    brands: new Map(),
    campaigns: new Map(),
    collections: new Map(),
    deals: new Map(),
    brandusers: new Map(),
  };

  // Collected during the users pass, consumed after collections/captains
  // exist — pickupHistory entries reference both, and collections is
  // migrated well after users.
  const pendingPickupHistory = []; // { userId, entries: [...] }

  const counts = {};
  const bump = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  console.log("Migrating organizations...");
  for (const doc of await db.collection("organizations").find().toArray()) {
    const id = await insertReturningId(pgClient, "organizations", {
      name: doc.name,
      plan: doc.plan ?? "starter",
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    idMaps.organizations.set(oidStr(doc._id), id);
    bump("organizations");
    for (const sub of doc.moduleSubscriptions ?? []) {
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
    const locationId = await insertReturningId(pgClient, "locations", {
      province: doc.province,
    });
    bump("locations");
    for (const city of doc.cities ?? []) {
      const cityId = await insertReturningId(pgClient, "cities", {
        location_id: locationId,
        name: city.name,
      });
      bump("cities");
      for (const townName of city.towns ?? []) {
        await insertRow(pgClient, "towns", { city_id: cityId, name: townName });
        bump("towns");
      }
    }
  }

  console.log("Migrating users...");
  for (const doc of await db.collection("users").find().toArray()) {
    const id = await insertReturningId(pgClient, "users", {
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
    idMaps.users.set(oidStr(doc._id), id);
    bump("users");

    const loc = doc.location ?? {};
    const addr = doc.structuredAddress ?? {};
    const ver = doc.locationVerification ?? {};
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
      await insertRow(pgClient, "user_otp_flows", {
        user_id: id,
        purpose: "password_reset",
        otp_hash: doc.passwordReset.otpHash,
        expires_at: doc.passwordReset.expiresAt,
        attempts: doc.passwordReset.attempts ?? 0,
        last_sent_at: doc.passwordReset.lastSentAt,
      });
      bump("user_otp_flows");
    }
    if (doc.emailVerification) {
      await insertRow(pgClient, "user_otp_flows", {
        user_id: id,
        purpose: "email_verification",
        otp_hash: doc.emailVerification.otpHash,
        expires_at: doc.emailVerification.expiresAt,
        attempts: doc.emailVerification.attempts ?? 0,
        last_sent_at: doc.emailVerification.lastSentAt,
      });
      bump("user_otp_flows");
    }

    for (const address of doc.referrals ?? []) {
      await insertRow(
        pgClient,
        "user_referrals",
        { user_id: id, address, created_at: null },
        { onConflictDoNothing: true },
      );
      bump("user_referrals");
    }

    if (doc.pickupHistory?.length) {
      pendingPickupHistory.push({ userId: id, entries: doc.pickupHistory });
    }
  }

  console.log("Migrating captains...");
  for (const doc of await db.collection("captains").find().toArray()) {
    const id = await insertReturningId(pgClient, "captains", {
      name: doc.name,
      phone: doc.phone,
      email: doc.email,
      password: doc.password,
      avatar: doc.avatar,
      national_id: doc.nationalId,
      national_id_image: doc.nationalIdImage,
      role: doc.role,
      device_token: doc.deviceToken,
      created: doc.created,
      email_verified: doc.emailVerified,
      verification_token: doc.verificationToken,
    });
    idMaps.captains.set(oidStr(doc._id), id);
    bump("captains");
  }

  console.log("Migrating logistics...");
  for (const doc of await db.collection("logistics").find().toArray()) {
    await insertRow(pgClient, "logistics", {
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
    const id = await insertReturningId(pgClient, "brands", {
      org_id: doc.orgId ? idMaps.organizations.get(oidStr(doc.orgId)) : null,
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
    idMaps.brands.set(oidStr(doc._id), id);
    bump("brands");
    if (doc.legacyBrandId) {
      pendingLegacyRefs.push({ id, legacyBrandId: oidStr(doc.legacyBrandId) });
    }

    if (doc.environmentalStats) {
      const statId = await insertReturningId(pgClient, "brand_environmental_stats", {
        brand_id: id,
        is_snapshot: true,
        period_start: null,
        period_end: null,
        total_waste_kg: doc.environmentalStats.totalWasteKg,
        co2_avoided_kg: doc.environmentalStats.co2AvoidedKg,
      });
      bump("brand_environmental_stats");
      for (const mb of doc.environmentalStats.materialBreakdown ?? []) {
        await insertRow(pgClient, "brand_environmental_material_breakdown", {
          stat_id: statId,
          material: mb.material,
          weight_kg: mb.weightKg,
        });
        bump("brand_environmental_material_breakdown");
      }
    }
    for (const period of doc.environmentalPeriods ?? []) {
      const statId = await insertReturningId(pgClient, "brand_environmental_stats", {
        brand_id: id,
        is_snapshot: false,
        period_start: period.periodStart,
        period_end: period.periodEnd,
        total_waste_kg: period.totalWasteKg,
        co2_avoided_kg: period.co2AvoidedKg,
      });
      bump("brand_environmental_stats");
      for (const mb of period.materialBreakdown ?? []) {
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
    const resolved = idMaps.brands.get(legacyBrandId);
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
    const brandId = idMaps.brands.get(oidStr(doc.brand));
    if (brandId === undefined) {
      warn(`campaigns "${doc.name}" (${doc._id}): brand ${doc.brand} not found — skipping campaign.`);
      continue;
    }
    const id = await insertReturningId(pgClient, "campaigns", {
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
    idMaps.campaigns.set(oidStr(doc._id), id);
    bump("campaigns");

    for (const code of doc.discountCodes ?? []) {
      await insertRow(
        pgClient,
        "campaign_discount_codes",
        { campaign_id: id, code, is_used: false, used_by_user_id: null, used_at: null },
        { onConflictDoNothing: true },
      );
      bump("campaign_discount_codes");
    }
    for (const a of doc.addresses ?? []) {
      await insertRow(pgClient, "campaign_addresses", {
        campaign_id: id,
        province: a.province,
        city: a.city,
        town: a.town,
      });
      bump("campaign_addresses");
    }
    for (const userRef of doc.users ?? []) {
      const userId = idMaps.users.get(oidStr(userRef));
      if (userId === undefined) {
        warn(`campaign ${doc._id}: user ${userRef} not found — skipping campaign_users row.`);
        continue;
      }
      await insertRow(pgClient, "campaign_users", { campaign_id: id, user_id: userId });
      bump("campaign_users");
    }
  }

  console.log("Migrating collections...");
  for (const doc of await db.collection("collections").find().toArray()) {
    const id = await insertReturningId(pgClient, "collections", {
      name: doc.name,
      area: doc.area,
      city: doc.city,
      radius: doc.radius,
      start_area_lat: doc.startAreaLat,
      start_area_lang: doc.startAreaLang,
      start_date: doc.startDate,
      status: doc.status,
    });
    idMaps.collections.set(oidStr(doc._id), id);
    bump("collections");

    for (const userRef of doc.users ?? []) {
      const userId = idMaps.users.get(oidStr(userRef));
      if (userId === undefined) {
        warn(`collection ${doc._id}: user ${userRef} not found — skipping collection_users row.`);
        continue;
      }
      await insertRow(pgClient, "collection_users", { collection_id: id, user_id: userId });
      bump("collection_users");
    }
    for (const cwd of doc.captainsWithDates ?? []) {
      const captainId = idMaps.captains.get(oidStr(cwd.captain));
      if (captainId === undefined) {
        warn(`collection ${doc._id}: captain ${cwd.captain} not found — skipping collection_captains row.`);
        continue;
      }
      await insertRow(pgClient, "collection_captains", {
        collection_id: id,
        captain_id: captainId,
        date: cwd.date,
      });
      bump("collection_captains");
    }
  }

  console.log("Migrating deals...");
  for (const doc of await db.collection("deals").find().toArray()) {
    const brandId = idMaps.brands.get(oidStr(doc.brand));
    if (brandId === undefined) {
      warn(`deal "${doc.title}" (${doc._id}): brand ${doc.brand} not found — skipping deal.`);
      continue;
    }
    const id = await insertReturningId(pgClient, "deals", {
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
    idMaps.deals.set(oidStr(doc._id), id);
    bump("deals");

    const issuedCodes = new Set();
    for (const code of doc.codes ?? []) {
      await insertRow(
        pgClient,
        "deal_codes",
        { deal_id: id, code, is_used: false },
        { onConflictDoNothing: true },
      );
      issuedCodes.add(code);
      bump("deal_codes");
    }
    for (const userRef of doc.users ?? []) {
      const userId = idMaps.users.get(oidStr(userRef));
      if (userId === undefined) {
        warn(`deal ${doc._id}: user ${userRef} not found — skipping deal_users row.`);
        continue;
      }
      await insertRow(pgClient, "deal_users", { deal_id: id, user_id: userId });
      bump("deal_users");
    }
    for (const claim of doc.claims ?? []) {
      const userId = idMaps.users.get(oidStr(claim.user));
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
    const orgId = idMaps.organizations.get(oidStr(doc.orgId));
    if (orgId === undefined) {
      warn(`branduser "${doc.email}" (${doc._id}): org ${doc.orgId} not found — skipping.`);
      continue;
    }
    const id = await insertReturningId(pgClient, "brandusers", {
      org_id: orgId,
      email: doc.email,
      password_hash: doc.passwordHash,
      org_role: doc.orgRole,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    idMaps.brandusers.set(oidStr(doc._id), id);
    bump("brandusers");

    for (const ma of doc.moduleAccess ?? []) {
      for (const permission of ma.permissions ?? []) {
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

  console.log("Migrating pickups / pickup_items (deferred until collections + captains exist)...");
  for (const { userId, entries } of pendingPickupHistory) {
    for (const entry of entries) {
      const collectionId = idMaps.collections.get(oidStr(entry.collectionId));
      const captainId = idMaps.captains.get(oidStr(entry.captain));
      if (collectionId === undefined || captainId === undefined) {
        warn(
          `pickup for user ${userId}: collectionId=${entry.collectionId} captain=${entry.captain} ` +
            `did not both resolve — skipping pickup (this is the un-remapped-ObjectId case the ` +
            `normalized schema is designed to surface).`,
        );
        continue;
      }
      const snap = entry.addressSnapshot;
      const pickupId = await insertReturningId(pgClient, "pickups", {
        user_id: userId,
        collection_id: collectionId,
        captain_id: captainId,
        occurred_at: entry.date,
        status: entry.status,
        comment: entry.comment,
        snapshot_address: snap?.address,
        snapshot_province: snap?.province,
        snapshot_city: snap?.city,
        snapshot_town: snap?.town,
        snapshot_town_other: snap?.townOther,
        snapshot_sub_area: snap?.subArea,
        snapshot_sub_area_other: snap?.subAreaOther,
        snapshot_structured_city_id: snap?.structuredAddress?.cityId,
        snapshot_structured_area_id: snap?.structuredAddress?.areaId,
        snapshot_structured_block_id: snap?.structuredAddress?.blockId,
        snapshot_structured_area_other: snap?.structuredAddress?.areaOther,
        snapshot_structured_block_other: snap?.structuredAddress?.blockOther,
        snapshot_house_no: snap?.structuredAddress?.houseNo,
        snapshot_street_or_block: snap?.structuredAddress?.streetOrBlock,
        snapshot_location_lng: snap?.location?.coordinates?.[0],
        snapshot_location_lat: snap?.location?.coordinates?.[1],
        snapshot_location_source: snap?.location?.source,
        snapshot_location_precision: snap?.location?.precision,
        snapshot_location_accuracy_meters: snap?.location?.accuracyMeters,
        snapshot_location_captured_at: snap?.location?.capturedAt,
        snapshot_source: snap?.snapshotSource,
        snapshot_at: snap?.snapshotAt,
      });
      bump("pickups");
      for (const qr of entry.qrCodesWithWeights ?? []) {
        await insertRow(pgClient, "pickup_items", {
          pickup_id: pickupId,
          qr_code: qr.qrCode,
          weight: qr.weight,
        });
        bump("pickup_items");
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
