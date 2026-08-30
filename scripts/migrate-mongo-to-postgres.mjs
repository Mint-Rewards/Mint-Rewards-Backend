#!/usr/bin/env node
// One-time MongoDB -> Postgres migration for the mint_rewards_test database,
// using a locally vendored, patched copy of mongo-to-postgres
// (github.com/alxnkt/mongo-to-postgres) — see
// scripts/vendor/mongo-to-postgres/NOTICE.md for what was patched and why
// (upstream silently drops any array field not wired up as a `links`
// many-to-many relation; this copy serializes it to jsonb instead).
//
// BEFORE RUNNING: create the target schema —
//   psql "$POSTGRES_URL_TEST" -f scripts/migrate-mongo-to-postgres.schema.sql
// The tool only INSERTs into existing empty tables; it never creates them.
//
// Hard-locked to the TEST databases (MONGODB_URI_TEST / POSTGRES_URL_TEST) —
// there is no --target flag, unlike the write scripts elsewhere in this
// directory that can also point at production. A post-connect guard below
// still refuses to run if either URI doesn't look like a test database.
//
// Every table is inserted into exactly once per run — this is not
// idempotent. Re-running against tables that already have rows in them will
// duplicate everything. Re-run schema.sql (or truncate) between attempts.
//
// Usage: node scripts/migrate-mongo-to-postgres.mjs --yes

import dotenv from "dotenv";
import migrate from "./vendor/mongo-to-postgres/index.js";

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

if (!process.argv.includes("--yes")) {
  console.log(
    "Dry run only. This would migrate 11 collections from " +
      `${redact(MONGODB_URI_TEST)} to ${redact(POSTGRES_URL_TEST)}.\n` +
      "Every insert is permanent and this is not idempotent — make sure " +
      "the target tables are empty (scripts/migrate-mongo-to-postgres.schema.sql).\n" +
      "Pass --yes to actually run it.",
  );
  process.exit(0);
}

function redact(uri) {
  return uri.replace(/\/\/[^@]+@/, "//<redacted>@");
}

// The vendored put-to-postgres.js detects a plain ObjectId array element by
// checking `relatedField.constructor.name === 'ObjectID'` (capital I-D).
// Modern bson (this project's mongoose ^9.2.1, resolved via node_modules)
// names that class `ObjectId`, not `ObjectID`, so that check never matches
// and the tool always falls through to the custom mapping-function branch —
// even for a plain array-of-ObjectId field. Every `links` entry below
// supplies an explicit mapping function for that reason; do not rely on the
// built-in auto-detection.
const mapObjectIdField = (linkRow, relatedField) => ({
  foreignKey: relatedField.toString(),
  linkRow,
});

const mapCaptainWithDate = (linkRow, relatedField) => ({
  foreignKey: relatedField.captain.toString(),
  linkRow: { ...linkRow, date: relatedField.date },
});

const mapDealClaim = (linkRow, relatedField) => ({
  foreignKey: relatedField.user.toString(),
  linkRow: {
    ...linkRow,
    code: relatedField.code,
    claimed_at: relatedField.claimedAt,
  },
});

// Order matters: a collection with a foreign key must come after the
// collection(s) it references, so that collection's idsMap already exists
// when this one's rows are inserted (mongo-to-postgres builds idsMap
// incrementally as it processes the `collections` array in order).
const collections = [
  {
    collectionName: "organizations",
    tableName: "organizations",
    fieldsRename: [
      ["name", "name"],
      ["plan", "plan"],
      ["moduleSubscriptions", "module_subscriptions"],
      ["createdAt", "created_at"],
      ["updatedAt", "updated_at"],
    ],
    // moduleSubscriptions has no migrated single-collection target to link
    // against, so it lands as a jsonb blob (see vendor/NOTICE.md) rather
    // than a real relation.
  },
  {
    collectionName: "brandthemes",
    tableName: "brandthemes",
    fieldsRename: [
      ["name", "name"],
      ["logo", "logo"],
      ["backgroundColor", "background_color"],
      ["accentColor", "accent_color"],
      ["status", "status"],
    ],
  },
  {
    collectionName: "users",
    tableName: "users",
    fieldsRename: [
      ["userName", "user_name"],
      ["email", "email"],
      ["password", "password"],
      ["avatar", "avatar"],
      ["address", "address"],
      ["province", "province"],
      ["city", "city"],
      ["town", "town"],
      ["townOther", "town_other"],
      ["subArea", "sub_area"],
      ["subAreaOther", "sub_area_other"],
      ["phone", "phone"],
      ["mintId", "mint_id"],
      ["role", "role"],
      ["latitude", "latitude"],
      ["longitude", "longitude"],
      ["deviceToken", "device_token"],
      ["points", "points"],
      ["totalCollections", "total_collections"],
      ["totalWasteCollected", "total_waste_collected"],
      ["referralRewardGranted", "referral_reward_granted"],
      ["location", "location"],
      ["structuredAddress", "structured_address"],
      ["locationVerification", "location_verification"],
      ["locationVersion", "location_version"],
      ["locationCompletedAt", "location_completed_at"],
      ["profileBonusWindowStartedAt", "profile_bonus_window_started_at"],
      ["profileBonusGrantedAt", "profile_bonus_granted_at"],
      ["profileBonusPoints", "profile_bonus_points"],
      ["referrals", "referrals"],
      ["pickupHistory", "pickup_history"],
      ["created", "created"],
      ["firstTimeLogin", "first_time_login"],
      ["passwordReset", "password_reset"],
      ["emailVerification", "email_verification"],
      ["emailVerified", "email_verified"],
      ["appleId", "apple_id"],
    ],
    // referrals and pickupHistory have no migrated single-collection target
    // to link against, so they land as jsonb blobs (see vendor/NOTICE.md).
    // The ObjectId refs inside pickupHistory entries (collectionId, captain)
    // stay as the original Mongo ids — they are NOT remapped to the new
    // Postgres integer ids, so don't join on them against collections/
    // captains without a separate remap step.
  },
  {
    collectionName: "captains",
    tableName: "captains",
    fieldsRename: [
      ["name", "name"],
      ["phone", "phone"],
      ["email", "email"],
      ["password", "password"],
      ["avatar", "avatar"],
      ["nationalId", "national_id"],
      ["nationalIdImage", "national_id_image"],
      ["role", "role"],
      ["deviceToken", "device_token"],
      ["created", "created"],
      ["emailVerified", "email_verified"],
      ["verificationToken", "verification_token"],
    ],
  },
  {
    collectionName: "logistics",
    tableName: "logistics",
    fieldsRename: [
      ["name", "name"],
      ["phone", "phone"],
      ["email", "email"],
      ["password", "password"],
      ["avatar", "avatar"],
      ["role", "role"],
      ["deviceToken", "device_token"],
      ["created", "created"],
      ["emailVerified", "email_verified"],
      ["verificationToken", "verification_token"],
    ],
  },
  {
    collectionName: "locations",
    tableName: "locations",
    fieldsRename: [
      ["province", "province"],
      ["cities", "cities"],
    ],
    // cities (and each city's nested towns) has no migrated
    // single-collection target to link against, so it lands as a jsonb
    // blob (see vendor/NOTICE.md) rather than normalized rows.
  },
  {
    collectionName: "brands",
    tableName: "brands",
    fieldsRename: [
      ["companyName", "company_name"],
      ["brandName", "brand_name"],
      ["email", "email"],
      ["logo", "logo"],
      ["themeImage", "theme_image"],
      ["category", "category"],
      ["description", "description"],
      ["address", "address"],
      ["webLink", "web_link"],
      ["appLink", "app_link"],
      ["contactName", "contact_name"],
      ["phone", "phone"],
      ["registrationNumber", "registration_number"],
      ["domain", "domain"],
      ["themeColor", "theme_color"],
      ["status", "status"],
      ["role", "role"],
      ["emailVerified", "email_verified"],
      ["verificationToken", "verification_token"],
      ["environmentalStats", "environmental_stats"],
      ["environmentalPeriods", "environmental_periods"],
      ["orgId", "org_id"],
      ["legacyBrandId", "legacy_brand_id"],
      ["createdAt", "created_at"],
      ["updatedAt", "updated_at"],
    ],
    // See schema.sql: legacy_brand_id is a self-reference and may resolve
    // to NULL depending on Mongo's return order within this run.
    foreignKeys: { orgId: "organizations", legacyBrandId: "brands" },
    // environmentalPeriods has no migrated single-collection target to link
    // against, so it lands as a jsonb blob (see vendor/NOTICE.md).
  },
  {
    collectionName: "campaigns",
    tableName: "campaigns",
    fieldsRename: [
      ["name", "name"],
      ["startDate", "start_date"],
      ["endDate", "end_date"],
      ["isSingleCode", "is_single_code"],
      ["discountPercentage", "discount_percentage"],
      ["discountCodes", "discount_codes"],
      ["addresses", "addresses"],
      ["status", "status"],
      ["brand", "brand_id"],
      ["brandRegistration", "brand_registration"],
      ["description", "description"],
      ["campaignType", "campaign_type"],
      ["targetAudience", "target_audience"],
      ["budget", "budget"],
      ["backgroundColor", "background_color"],
      ["badge", "badge"],
      ["subtitle", "subtitle"],
      ["banner", "banner"],
    ],
    foreignKeys: { brand: "brands", users: "users" },
    links: {
      users: ["campaign_users", "campaign_id", "user_id", mapObjectIdField],
    },
    // discountCodes and addresses have no migrated single-collection target
    // to link against, so they land as jsonb blobs (see vendor/NOTICE.md).
  },
  {
    collectionName: "collections",
    tableName: "collections",
    fieldsRename: [
      ["name", "name"],
      ["area", "area"],
      ["city", "city"],
      ["radius", "radius"],
      ["startAreaLat", "start_area_lat"],
      ["startAreaLang", "start_area_lang"],
      ["startDate", "start_date"],
      ["status", "status"],
    ],
    foreignKeys: { users: "users", captainsWithDates: "captains" },
    links: {
      users: [
        "collection_users",
        "collection_id",
        "user_id",
        mapObjectIdField,
      ],
      captainsWithDates: [
        "collection_captains",
        "collection_id",
        "captain_id",
        mapCaptainWithDate,
      ],
    },
  },
  {
    collectionName: "deals",
    tableName: "deals",
    fieldsRename: [
      ["brand", "brand_id"],
      ["title", "title"],
      ["description", "description"],
      ["discountPercentage", "discount_percentage"],
      ["discountAmount", "discount_amount"],
      ["codes", "codes"],
      ["promoCode", "promo_code"],
      ["startDate", "start_date"],
      ["endDate", "end_date"],
      ["maxUses", "max_uses"],
      ["currentUses", "current_uses"],
      ["minimumPurchase", "minimum_purchase"],
      ["status", "status"],
      ["createdAt", "created_at"],
      ["updatedAt", "updated_at"],
    ],
    foreignKeys: { brand: "brands", users: "users", claims: "users" },
    links: {
      users: ["deal_users", "deal_id", "user_id", mapObjectIdField],
      claims: ["deal_claims", "deal_id", "user_id", mapDealClaim],
    },
    // codes has no migrated single-collection target to link against, so
    // it lands as a jsonb blob (see vendor/NOTICE.md).
  },
  {
    collectionName: "brandusers",
    tableName: "brandusers",
    fieldsRename: [
      ["orgId", "org_id"],
      ["email", "email"],
      ["passwordHash", "password_hash"],
      ["orgRole", "org_role"],
      ["moduleAccess", "module_access"],
      ["createdAt", "created_at"],
      ["updatedAt", "updated_at"],
    ],
    foreignKeys: { orgId: "organizations" },
    // moduleAccess has no migrated single-collection target to link
    // against, so it lands as a jsonb blob (see vendor/NOTICE.md).
  },
];

await migrate({
  connections: {
    mongo: MONGODB_URI_TEST,
    postgres: POSTGRES_URL_TEST,
  },
  collections,
});
