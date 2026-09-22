-- Consumer accounts. The last model off Mongo, and the one everything points at.
--
-- Shaped so public.user_directory can become a view over this table instead of
-- a synced copy: geog, precision, source, location_version, mint_id, phone,
-- email and email_verified are named and typed to match it. That projection
-- exists only because users lived in another store.
--
-- TWO SECURITY PROPERTIES, both easy to lose:
--
-- 1. password, password_reset and email_verification hold a bcrypt hash and
--    two OTP hashes. The last two carried `select: false` in Mongoose, so an
--    ordinary read could not return them. Postgres has no such flag, so the
--    repository projects columns explicitly and omits these unless asked.
--    A `SELECT *` anywhere in application code undoes that.
--
-- 2. profile_bonus_granted_at is the idempotency key for the payout: the claim
--    matches on it being NULL, which is what makes a concurrent second call
--    match nothing. It has no DEFAULT and must never be given one.

CREATE TABLE IF NOT EXISTS consumer.users (
  id                              text PRIMARY KEY,

  user_name                       text NOT NULL,
  email                           text NOT NULL,
  password                        text NOT NULL,
  mint_id                         text NOT NULL,
  role                            text NOT NULL DEFAULT 'MEMBER',
  phone                           text NOT NULL DEFAULT '',
  avatar                          text NOT NULL DEFAULT '',

  -- Legacy address strings, still dual-written.
  address                         text NOT NULL DEFAULT '',
  province                        text NOT NULL DEFAULT '',
  city                            text NOT NULL DEFAULT '',
  town                            text NOT NULL DEFAULT '',
  town_other                      text NOT NULL DEFAULT '',
  sub_area                        text NOT NULL DEFAULT '',
  sub_area_other                  text NOT NULL DEFAULT '',
  -- Strings, as Mongo held them: often '' and occasionally unparseable.
  latitude                        text NOT NULL DEFAULT '',
  longitude                       text NOT NULL DEFAULT '',

  device_token                    text NOT NULL DEFAULT '',
  points                          integer NOT NULL DEFAULT 0,
  total_collections               text NOT NULL DEFAULT '',
  total_waste_collected           text NOT NULL DEFAULT '',

  -- Unbounded in Mongo, where it counted against the 16MB document cap. A
  -- text[] column has no such ceiling, so that caveat no longer applies.
  referrals                       text[] NOT NULL DEFAULT '{}',
  referral_reward_granted         boolean NOT NULL DEFAULT false,

  -- Structured location. Same column names and types as user_directory.
  geog                            geography(Point, 4326),
  precision                       text,
  source                          text,
  accuracy_meters                 double precision,
  captured_at                     timestamptz,

  structured_address              jsonb,
  -- Kept whole: every row where geocodedAreaRaw and selectedAreaId disagree is
  -- a labelled geocoder failure at a known coordinate, and collapsing the two
  -- throws away the gazetteer's training data.
  location_verification           jsonb,

  location_version                integer NOT NULL DEFAULT 0,
  location_completed_at           timestamptz,

  profile_bonus_window_started_at timestamptz,
  -- No DEFAULT. Presence is the idempotency key for the payout.
  profile_bonus_granted_at        timestamptz,
  profile_bonus_points            integer,

  pickup_history                  jsonb NOT NULL DEFAULT '[]'::jsonb,

  created                         timestamptz NOT NULL DEFAULT now(),
  first_time_login                boolean NOT NULL DEFAULT true,

  -- OTP hashes. Never in a default projection.
  password_reset                  jsonb,
  email_verification              jsonb,

  email_verified                  boolean NOT NULL DEFAULT false,
  apple_id                        text,

  CONSTRAINT users_precision_check
    CHECK (precision IS NULL OR precision IN
      ('building', 'block', 'area', 'city', 'unknown')),
  CONSTRAINT users_source_check
    CHECK (source IS NULL OR source IN
      ('map_pin', 'area_centroid', 'city_centroid', 'legacy_string',
       'collector_verified'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key   ON consumer.users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_mint_id_key ON consumer.users (mint_id);
-- Sparse in Mongo: only linked accounts have one, and the nulls must not
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS users_apple_id_key
  ON consumer.users (apple_id) WHERE apple_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_email_verified_idx   ON consumer.users (email_verified);
CREATE INDEX IF NOT EXISTS users_location_version_idx ON consumer.users (location_version);
CREATE INDEX IF NOT EXISTS users_geog_idx             ON consumer.users USING gist (geog);
