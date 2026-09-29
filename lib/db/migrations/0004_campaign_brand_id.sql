-- The `brandId` field campaigns carry alongside `brand`.
--
-- It is not in CampaignSchema — it was written directly by the migration that
-- repointed campaigns from legacy brand documents to their BrandHub clones,
-- and it holds the OTHER document's id. /api/users/active-campaigns reads it
-- to resolve a repointed campaign back to whichever of the pair is listed, so
-- dropping it silently unpairs those campaigns and their brand card goes empty
-- with no error anywhere. That is issue #98 again by a different route.
--
-- The first version of consumer.campaigns modelled the Mongoose schema and so
-- did not have this column. 7 of 8 production campaigns carry the field; dev
-- carries none, which is why nothing failed here.
--
-- Named brand_id for fidelity with the field it mirrors, confusing though it
-- is next to `brand`. `brand` is who owns the campaign; `brand_id` is the
-- other half of a legacy pairing.
ALTER TABLE consumer.campaigns ADD COLUMN IF NOT EXISTS brand_id text;

CREATE INDEX IF NOT EXISTS campaigns_brand_id_idx
  ON consumer.campaigns (brand_id) WHERE brand_id IS NOT NULL;
