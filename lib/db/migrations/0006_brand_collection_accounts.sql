-- A brand can be a collection customer too.
--
-- Trifit asked us to pick waste up from them, which makes a brand a consumer
-- of the collection service as well as a partner in it. The whole collection
-- pipeline is keyed on a user id -- collection_stops.user_id, the
-- user_directory view, zone containment, routing, the no-pin-no-collection
-- rule, a household's own history -- so a brand that wants collections gets a
-- collection account here and everything downstream works unchanged.
--
-- The alternative was making stops polymorphic over households and brands.
-- That means touching assignment, the directory, the app and the console, to
-- express something that is true either way: this is an address with a name,
-- a number and a pin, and a van goes to it.

CREATE TYPE consumer.account_type AS ENUM ('HOUSEHOLD', 'BRAND');

-- Defaulted for everything that exists, because everything that exists is a
-- household. The column is what tells them apart from here on; `role` is a
-- free-text string nothing validates and was never going to carry this.
ALTER TABLE consumer.users
  ADD COLUMN account_type consumer.account_type NOT NULL DEFAULT 'HOUSEHOLD';

-- Which brand this account collects for. Null for every household.
--
-- Deliberately NOT unique: a brand may have several sites, and their impact
-- sums across them. Allowing that now costs nothing and avoids a migration
-- the first time somebody has two branches.
ALTER TABLE consumer.users
  ADD COLUMN brand_id text REFERENCES consumer.brands(id) ON DELETE SET NULL;

-- The two must agree. A BRAND account with no brand is unattributable impact,
-- and a household carrying a brand id would put a family's waste on a
-- company's ESG report.
ALTER TABLE consumer.users
  ADD CONSTRAINT users_brand_account_check
  CHECK ((account_type = 'BRAND') = (brand_id IS NOT NULL));

-- The dashboard asks "what did this brand's own collections come to", which
-- is a lookup by brand across a handful of rows.
CREATE INDEX users_brand_id_idx ON consumer.users (brand_id)
  WHERE brand_id IS NOT NULL;
