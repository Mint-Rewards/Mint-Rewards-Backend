-- Campaigns and deals. See docs/VOCABULARY.md: a Campaign is a recycling
-- programme, a Deal is the incentive a household gets.
--
-- `users` and `codes` are text[] rather than jsonb. The deal-claim path is a
-- compare-and-swap -- it matches on the current use count AND on the claimer
-- not already being in `users`, then appends -- and a native array expresses
-- that as one guarded UPDATE, which is what keeps two concurrent requests from
-- being handed the same code.
--
-- `brand` is NOT a foreign key to consumer.brands. Campaigns exist whose brand
-- was never migrated, and a constraint would drop them at backfill rather than
-- surface them.
--
-- Dates stay text, as they were in Mongo: the stored values are whatever the
-- brand portal wrote, and retyping would reject the malformed ones during the
-- migration rather than on read -- turning a display problem into data loss.

CREATE TABLE IF NOT EXISTS consumer.campaigns (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  start_date           text,
  end_date             text,
  discount_codes       text[] NOT NULL DEFAULT '{}',
  is_single_code       boolean NOT NULL DEFAULT false,
  discount_percentage  text,
  addresses            jsonb NOT NULL DEFAULT '[]'::jsonb,
  status               text NOT NULL DEFAULT 'PENDING',
  -- Consumer ids. Still Mongo ObjectIds; User has not moved yet.
  users                text[] NOT NULL DEFAULT '{}',
  brand                text NOT NULL,
  brand_registration   text NOT NULL DEFAULT '',
  description          text,
  campaign_type        text,
  target_audience      text,
  budget               integer,
  background_color     text,
  badge                text,
  subtitle             text,
  banner               text,
  CONSTRAINT campaigns_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS campaigns_brand_idx              ON consumer.campaigns (brand);
CREATE INDEX IF NOT EXISTS campaigns_status_idx             ON consumer.campaigns (status);
CREATE INDEX IF NOT EXISTS campaigns_brand_registration_idx ON consumer.campaigns (brand_registration);

CREATE TABLE IF NOT EXISTS consumer.deals (
  id                   text PRIMARY KEY,
  brand                text NOT NULL,
  title                text NOT NULL,
  description          text NOT NULL DEFAULT '',
  discount_percentage  integer,
  discount_amount      integer,
  -- Inventory of codes; promo_code mirrors codes[0] for legacy readers.
  codes                text[] NOT NULL DEFAULT '{}',
  promo_code           text,
  start_date           text,
  end_date             text,
  max_uses             integer,
  -- The claim cursor. The compare-and-swap matches on this exact value.
  current_uses         integer NOT NULL DEFAULT 0,
  minimum_purchase     integer,
  status               text NOT NULL DEFAULT 'pending',
  users                text[] NOT NULL DEFAULT '{}',
  -- Append-only log of { user, code, claimedAt }. Never searched by element.
  claims               jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deals_status_check
    CHECK (status IN ('pending', 'active', 'rejected', 'inactive', 'expired')),
  -- The claim cursor must never outrun the inventory it indexes into.
  CONSTRAINT deals_current_uses_check CHECK (current_uses >= 0)
);

CREATE INDEX IF NOT EXISTS deals_brand_idx  ON consumer.deals (brand);
CREATE INDEX IF NOT EXISTS deals_status_idx ON consumer.deals (status);

-- Membership tests on the claim path: `NOT (users @> ARRAY[$1])`.
CREATE INDEX IF NOT EXISTS deals_users_gin ON consumer.deals USING gin (users);
