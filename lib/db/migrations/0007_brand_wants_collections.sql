-- The toggle itself: "we would like our waste collected too".
--
-- Lives on the brand rather than on the collection account, because it is the
-- brand's decision and it has to be answerable before an account exists --
-- both at sign-up, where the brand is being created in the same breath, and
-- afterwards from settings.
--
-- The account in consumer.users is created when this is first switched on and
-- is NOT removed when it is switched off. Collections that already happened
-- are the brand's own record, and deleting the account to honour a toggle
-- would take that history with it.

ALTER TABLE consumer.brands
  ADD COLUMN wants_collections boolean NOT NULL DEFAULT false;
