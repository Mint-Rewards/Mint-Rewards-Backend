-- What a household has recycled, as a running total they can be shown.
--
-- `total_waste_collected` and `total_collections` already existed, carried over
-- from Mongo, and have been read by the app's home screen ever since. Nothing
-- has ever written them: the backfill filled them once and they have been
-- frozen since, so every household who has recycled with us since the migration
-- sees zero kilos on a screen that exists to tell them otherwise.
--
-- They are written now by the warehouse bench, at the same moment and in the
-- same transaction as the points award -- which is the only moment the figures
-- are known, because weighing happens there.
--
-- `total_co2_kg` is new, and it is new because the app was computing CO2
-- itself: waste x 0.21, a factor belonging to nothing, giving a number that
-- agreed with neither the blended 2.2 this service uses nor the per-material
-- sum the bench now records. Three answers to one question. The service that
-- knows what was in each bag owns the figure, and the app reads it.
--
-- Numeric, unlike the two text columns beside it. Those are Mongo's shape and
-- changing them would reach into the app's types and the repository's
-- projection for no gain today; a new column has no such excuse.

ALTER TABLE consumer.users
  ADD COLUMN IF NOT EXISTS total_co2_kg numeric(12,3) NOT NULL DEFAULT 0;
