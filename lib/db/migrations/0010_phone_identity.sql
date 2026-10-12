-- A phone number somebody can sign in with.
--
-- Email is the only identity this system has, and in Pakistan that is the
-- wrong one to insist on: a household signing up at their door has a phone in
-- their hand and often no email they read. Every signup that stalls at "check
-- your email" is a household we never collect from.
--
-- Nothing here migrates anybody. The 4,446 existing accounts carrying a
-- parseable number keep it exactly as typed, and none of them becomes
-- verified — so none enters the unique index below and no existing login
-- changes in any way. See docs/specs/phone-and-whatsapp-signup.md.

-- The verified number, always E.164: +923001234567.
--
-- Deliberately NOT the existing `phone` column. That one holds whatever a
-- person ever typed — including the 212 rows that are just "+92" and the 37
-- holding "555-666-0606" — it is what the captain app and the ops console
-- display, and rewriting it in place would destroy the only record of what
-- was entered. This column is the one anything authenticates against, and it
-- is written ONLY after an OTP has been answered.
ALTER TABLE consumer.users
  ADD COLUMN IF NOT EXISTS phone_e164 text;
--> statement-breakpoint

-- When the number was proved, and the flag that it was.
--
-- A timestamp rather than a boolean because "when" is the question asked
-- afterwards — by support looking at a disputed account, and by any future
-- policy that re-verifies a number after some age. A boolean cannot answer it
-- and cannot be widened later without a backfill that invents dates.
ALTER TABLE consumer.users
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
--> statement-breakpoint

-- The OTP block for a number, mirroring email_verification exactly.
--
-- Same shape, same hashing, same atomic burn — `setUserOtp`, `recordOtpAttempt`
-- and `consumeOtp` already take a discriminator and this is a third case
-- rather than a new mechanism. The code itself is never stored, only its hash.
ALTER TABLE consumer.users
  ADD COLUMN IF NOT EXISTS phone_verification jsonb;
--> statement-breakpoint

-- One verified number, one account.
--
-- Partial on purpose. Unverified numbers are not identities — thousands of
-- rows already hold duplicates and junk, and a full unique index could not be
-- created at all without deleting real accounts. Restricting it to verified
-- rows means the constraint describes exactly the thing it is protecting:
-- nobody can prove the same number twice.
--
-- Known gap, written down rather than solved: a soft-deleted row keeps its
-- number, so a genuinely different person who is later issued that recycled
-- number cannot verify it. Email behaves the same way today, and the way back
-- for the original owner is reviving their account. Worth revisiting if it is
-- ever seen in the wild.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_e164_verified_key
  ON consumer.users (phone_e164)
  WHERE phone_verified_at IS NOT NULL;
--> statement-breakpoint

-- For the lookup that happens before verification: "is this number known?"
-- Partial, because the column is null on every account that predates this.
CREATE INDEX IF NOT EXISTS users_phone_e164_idx
  ON consumer.users (phone_e164)
  WHERE phone_e164 IS NOT NULL;
