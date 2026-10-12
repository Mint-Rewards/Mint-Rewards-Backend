-- An account signed up by phone has no password.
--
-- They prove a number each time instead, so there is nothing to store. The
-- alternative was a bcrypt hash of a random secret — a value no password can
-- ever match, which works and reads as a lie: anybody looking at the row, or
-- at a support export, sees an account that appears to have a password and
-- cannot tell it is unusable.
--
-- Distinct from the email decision in 0011 only in degree. A synthesised
-- address leaks into receipts and mailshots; a synthesised hash leaks
-- nowhere. It is still a value that says something untrue about the account,
-- and the cost of being honest here is one nullable column.
--
-- `users_need_a_credential` still guarantees every row can be reached: an
-- email or a number. Being unable to sign in with a password is not the same
-- as being unreachable.

ALTER TABLE consumer.users
  ALTER COLUMN password DROP NOT NULL;
