-- Postgres schema for the MongoDB -> Postgres migration of mint_rewards_test,
-- run via `npm run migrate:pg:test` (scripts/migrate-mongo-to-postgres.mjs).
--
-- mongo-to-postgres (github.com/alxnkt/mongo-to-postgres) never creates
-- tables itself -- it only INSERTs into tables that already exist and are
-- empty. Run this file against the target Postgres database first:
--
--   psql "$POSTGRES_URL_TEST" -f scripts/migrate-mongo-to-postgres.schema.sql
--
-- Table order matches lib/models.ts collection dependency order: a table
-- with a foreign key is always created (and, at migration time, populated)
-- after the table it references, per the tool's own requirement.
--
-- ARRAY FIELDS -- migrate-mongo-to-postgres.mjs imports a locally vendored,
-- patched copy of the migration tool (scripts/vendor/mongo-to-postgres,
-- see its NOTICE.md) rather than the npm package directly. Upstream
-- silently drops every array-valued field before insert unless it's wired
-- up as a many-to-many `links` relation; the patch serializes any other
-- array to JSON instead, which is why the jsonb columns below exist:
--   organizations.module_subscriptions, brands.environmental_periods,
--   users.referrals, users.pickup_history, campaigns.discount_codes,
--   campaigns.addresses, locations.cities (nested towns included),
--   deals.codes, brandusers.module_access.
-- These are raw JSON dumps, not normalized relational data, and Mongo
-- ObjectIds embedded inside them (e.g. users.pickup_history entries'
-- collectionId/captain) are NOT remapped to the new Postgres ids -- they
-- stay as the original Mongo hex ids. Don't join on those without a
-- separate remap step.

-- ---------------------------------------------------------------------
-- organizations  (Mongo collection: organizations)
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  plan                 TEXT NOT NULL DEFAULT 'starter'
                       CHECK (plan IN ('starter', 'growth', 'enterprise')),
  module_subscriptions JSONB,
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- brandthemes  (Mongo collection: brandthemes)
-- ---------------------------------------------------------------------
CREATE TABLE brandthemes (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  logo             TEXT NOT NULL,
  background_color TEXT NOT NULL,
  accent_color     TEXT NOT NULL,
  status           TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- users  (Mongo collection: users)
-- Nested single-object fields (location, structured_address,
-- location_verification, password_reset, email_verification) and the
-- array fields (referrals, pickup_history) all come across as jsonb --
-- keys inside stay camelCase as they were in Mongo. See ARRAY FIELDS above
-- for the caveat on ids embedded inside pickup_history.
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                              SERIAL PRIMARY KEY,
  user_name                       TEXT NOT NULL,
  email                           TEXT NOT NULL UNIQUE,
  password                        TEXT NOT NULL,
  avatar                          TEXT NOT NULL DEFAULT '',
  address                         TEXT NOT NULL DEFAULT '',
  province                        TEXT NOT NULL DEFAULT '',
  city                            TEXT NOT NULL DEFAULT '',
  town                            TEXT NOT NULL DEFAULT '',
  town_other                      TEXT NOT NULL DEFAULT '',
  sub_area                        TEXT NOT NULL DEFAULT '',
  sub_area_other                  TEXT NOT NULL DEFAULT '',
  phone                           TEXT NOT NULL DEFAULT '',
  mint_id                         TEXT NOT NULL UNIQUE,
  role                            TEXT NOT NULL DEFAULT 'MEMBER',
  latitude                        TEXT NOT NULL DEFAULT '',
  longitude                       TEXT NOT NULL DEFAULT '',
  device_token                    TEXT NOT NULL DEFAULT '',
  points                          INTEGER NOT NULL DEFAULT 0,
  total_collections               TEXT NOT NULL DEFAULT '',
  total_waste_collected           TEXT NOT NULL DEFAULT '',
  referral_reward_granted         BOOLEAN NOT NULL DEFAULT FALSE,
  referrals                       JSONB,
  location                        JSONB,
  structured_address              JSONB,
  location_verification           JSONB,
  location_version                INTEGER NOT NULL DEFAULT 0,
  location_completed_at           TIMESTAMPTZ,
  profile_bonus_window_started_at TIMESTAMPTZ,
  profile_bonus_granted_at        TIMESTAMPTZ,
  profile_bonus_points            INTEGER,
  pickup_history                  JSONB,
  created                         TIMESTAMPTZ,
  first_time_login                BOOLEAN NOT NULL DEFAULT TRUE,
  password_reset                  JSONB,
  email_verification              JSONB,
  email_verified                  BOOLEAN NOT NULL DEFAULT FALSE,
  apple_id                        TEXT UNIQUE
);

-- ---------------------------------------------------------------------
-- captains  (Mongo collection: captains)
-- ---------------------------------------------------------------------
CREATE TABLE captains (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
  password           TEXT NOT NULL,
  avatar             TEXT NOT NULL DEFAULT '',
  national_id        TEXT,
  national_id_image  TEXT,
  role               TEXT NOT NULL DEFAULT 'CAPTAIN',
  device_token       TEXT NOT NULL DEFAULT '',
  created            TIMESTAMPTZ,
  email_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token TEXT
);

-- ---------------------------------------------------------------------
-- logistics  (Mongo collection: logistics)
-- ---------------------------------------------------------------------
CREATE TABLE logistics (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
  password           TEXT NOT NULL,
  avatar             TEXT NOT NULL DEFAULT '',
  role               TEXT NOT NULL DEFAULT 'LOGISTIC',
  device_token       TEXT NOT NULL DEFAULT '',
  created            TIMESTAMPTZ,
  email_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token TEXT
);

-- ---------------------------------------------------------------------
-- locations  (Mongo collection: locations)
-- `cities` (and each city's nested `towns`) has no migrated
-- single-collection target to link against, so it lands as jsonb -- see
-- ARRAY FIELDS above.
-- ---------------------------------------------------------------------
CREATE TABLE locations (
  id       SERIAL PRIMARY KEY,
  province TEXT NOT NULL,
  cities   JSONB
);

-- ---------------------------------------------------------------------
-- brands  (Mongo collection: brands)
-- `legacy_brand_id` is a self-reference. The migration tool resolves
-- foreign keys against an in-memory id map built up as it inserts rows
-- *within a single run*, in whatever order Mongo returns them -- for a
-- self-referencing collection that means a legacy brand inserted after the
-- brand that points at it will resolve to NULL instead of the real link.
-- Expect some NULLs here; don't treat a NULL as "this brand has no legacy
-- pair" without checking Mongo.
-- ---------------------------------------------------------------------
CREATE TABLE brands (
  id                  SERIAL PRIMARY KEY,
  org_id              INTEGER REFERENCES organizations(id),
  legacy_brand_id     INTEGER REFERENCES brands(id),
  company_name        TEXT NOT NULL,
  brand_name          TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  logo                TEXT,
  theme_image         TEXT,
  category            TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  address             TEXT NOT NULL DEFAULT '',
  web_link            TEXT NOT NULL,
  app_link            TEXT NOT NULL DEFAULT '',
  contact_name        TEXT NOT NULL,
  phone               TEXT NOT NULL,
  registration_number TEXT NOT NULL UNIQUE,
  domain              TEXT NOT NULL DEFAULT '',
  theme_color         TEXT NOT NULL DEFAULT '#3B82F6',
  status              TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  role                TEXT NOT NULL DEFAULT 'BRAND',
  email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token  TEXT,
  environmental_stats JSONB,
  environmental_periods JSONB,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- campaigns  (Mongo collection: campaigns)
-- `discount_codes` and `addresses` land as jsonb -- see ARRAY FIELDS above.
-- `users` is a many-to-many link, carried via campaign_users below.
-- ---------------------------------------------------------------------
CREATE TABLE campaigns (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  start_date         TEXT,
  end_date           TEXT,
  is_single_code     BOOLEAN NOT NULL DEFAULT FALSE,
  discount_percentage TEXT,
  discount_codes     JSONB,
  addresses          JSONB,
  status             TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  brand_id           INTEGER NOT NULL REFERENCES brands(id),
  brand_registration TEXT NOT NULL DEFAULT '',
  description        TEXT,
  campaign_type      TEXT,
  target_audience    TEXT,
  budget             NUMERIC,
  background_color   TEXT,
  badge              TEXT,
  subtitle           TEXT,
  banner             TEXT
);

CREATE TABLE campaign_users (
  id          SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  user_id     INTEGER NOT NULL REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- collections  (Mongo collection: collections)
-- `users` and `captainsWithDates` are many-to-many links, carried via the
-- two join tables below.
-- ---------------------------------------------------------------------
CREATE TABLE collections (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  area            TEXT NOT NULL,
  city            TEXT NOT NULL,
  radius          TEXT NOT NULL,
  start_area_lat  TEXT NOT NULL,
  start_area_lang TEXT NOT NULL,
  start_date      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'COMPLETED'))
);

CREATE TABLE collection_users (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  user_id       INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE collection_captains (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  captain_id    INTEGER NOT NULL REFERENCES captains(id),
  date          TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- deals  (Mongo collection: deals)
-- `codes` lands as jsonb -- see ARRAY FIELDS above. `users` and `claims`
-- are many-to-many links, carried via the two join tables below.
-- ---------------------------------------------------------------------
CREATE TABLE deals (
  id                  SERIAL PRIMARY KEY,
  brand_id            INTEGER NOT NULL REFERENCES brands(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  discount_percentage NUMERIC,
  discount_amount     NUMERIC,
  codes               JSONB,
  promo_code          TEXT,
  start_date          TEXT,
  end_date            TEXT,
  max_uses            INTEGER,
  current_uses        INTEGER NOT NULL DEFAULT 0,
  minimum_purchase    NUMERIC,
  status              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'rejected', 'inactive', 'expired')),
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ
);

CREATE TABLE deal_users (
  id      SERIAL PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  user_id INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE deal_claims (
  id         SERIAL PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  code       TEXT NOT NULL,
  claimed_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- brandusers  (Mongo collection: brandusers)
-- `module_access` lands as jsonb -- see ARRAY FIELDS above.
-- ---------------------------------------------------------------------
CREATE TABLE brandusers (
  id            SERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  org_role      TEXT NOT NULL,
  module_access JSONB,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ
);
