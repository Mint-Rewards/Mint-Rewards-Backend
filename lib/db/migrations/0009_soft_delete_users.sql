-- Deleting an account stops destroying the row.
--
-- The hard DELETE it replaces was being played. A deal hands out one code per
-- USER ID -- `AND NOT (user_id = ANY(users))` in claimDealCode -- and deleting
-- the account issued a brand new id, so the same person could delete, sign up
-- with the same email, and claim the same deal again. Repeat until the brand's
-- whole allocation is gone. Nothing anywhere keyed on something that survived
-- the delete, so nothing could notice.
--
-- Keeping the row keeps the id, and the id is what every one of those guards is
-- written against -- deals, referrals, the signup grant. The exploit closes
-- because the person stays the same person.
--
-- What leaving is now:
--   * deleted_at is set
--   * points, waste, collections and CO2 are zeroed
--   * every read treats them as absent: no login, no directory, no map
--
-- And coming back reactivates this row rather than making another, so they
-- return as themselves with nothing — no history, no points, and no second
-- signup grant.

ALTER TABLE consumer.users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint

-- Every read filters on this, and they all filter the same way: WHERE
-- deleted_at IS NULL. A partial index is the shape that matches, and it keeps
-- the index off the rows nobody looks up.
CREATE INDEX IF NOT EXISTS users_active_email_idx
  ON consumer.users (email) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- The email stays UNIQUE across deleted rows too, deliberately.
--
-- It is what lets somebody come back: signup looks the address up, finds the
-- row it belongs to, and revives it. Releasing the address instead would hand
-- the same person a new id and reopen exactly the hole this closes.
