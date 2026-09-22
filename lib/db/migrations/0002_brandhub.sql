-- BrandHub: organisations, their logins, and their brands.
--
-- These three move together. Signup creates all three inside one transaction
-- because committing them separately once left people with a real org and
-- login but zero brands, after a UI that said signup had failed. No
-- transaction spans Mongo and Postgres, so they could not be ported apart.
--
-- Primary keys are the Mongo ObjectId hex as text, not new generated ids:
-- BrandHub JWTs carry orgId, and Campaign and Deal still hold brand ObjectIds
-- from Mongo. Minting fresh ids would invalidate every live session and orphan
-- every campaign on the day of the cutover.
--
-- The enum-like columns are CHECK constraints rather than pg enums, for the
-- same reason as logs.level: Mongo enforced these in the application, so a
-- type that rejects an unexpected value outright would fail on data the old
-- store accepted.

CREATE TABLE IF NOT EXISTS consumer.organizations (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  plan                 text NOT NULL DEFAULT 'starter',
  -- Read whole on every module-guarded request and never queried across
  -- organisations, so a child table would cost a join and buy nothing.
  module_subscriptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_plan_check
    CHECK (plan IN ('starter', 'growth', 'enterprise'))
);

CREATE TABLE IF NOT EXISTS consumer.brand_users (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES consumer.organizations(id),
  -- Stored lower-cased, as Mongo's `lowercase: true` did.
  email         text NOT NULL,
  password_hash text NOT NULL,
  org_role      text NOT NULL,
  module_access jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brand_users_email_key  ON consumer.brand_users (email);
CREATE INDEX        IF NOT EXISTS brand_users_org_id_idx ON consumer.brand_users (org_id);

CREATE TABLE IF NOT EXISTS consumer.brands (
  id                    text PRIMARY KEY,
  -- Optional: legacy brands predate organisations and must stay valid.
  org_id                text REFERENCES consumer.organizations(id),
  -- Pairs a cloned brand with its source. Deliberately not a foreign key --
  -- the legacy brand it points at may not have been migrated.
  legacy_brand_id       text,
  company_name          text NOT NULL,
  brand_name            text NOT NULL,
  email                 text NOT NULL,
  logo                  text,
  theme_image           text,
  category              text NOT NULL,
  description           text NOT NULL DEFAULT '',
  address               text NOT NULL DEFAULT '',
  web_link              text NOT NULL,
  app_link              text NOT NULL DEFAULT '',
  contact_name          text NOT NULL,
  phone                 text NOT NULL,
  registration_number   text NOT NULL,
  domain                text NOT NULL DEFAULT '',
  theme_color           text NOT NULL DEFAULT '#3B82F6',
  status                text NOT NULL DEFAULT 'PENDING',
  role                  text NOT NULL DEFAULT 'BRAND',
  email_verified        boolean NOT NULL DEFAULT false,
  verification_token    text,
  -- A lone snapshot, and separately a list of dated buckets. Two fields on
  -- purpose: existing documents hold a single subdocument in the first, and
  -- folding it into the array would break every legacy brand on read.
  environmental_stats   jsonb,
  environmental_periods jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS brands_email_key               ON consumer.brands (email);
CREATE UNIQUE INDEX IF NOT EXISTS brands_registration_number_key ON consumer.brands (registration_number);
CREATE INDEX        IF NOT EXISTS brands_org_id_idx              ON consumer.brands (org_id);
CREATE INDEX        IF NOT EXISTS brands_legacy_brand_id_idx     ON consumer.brands (legacy_brand_id);
CREATE INDEX        IF NOT EXISTS brands_status_idx              ON consumer.brands (status);
