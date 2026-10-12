-- An account may have no email address.
--
-- A phone-first signup has nothing to put in this column, and the two ways
-- out are making it nullable or synthesising something like
-- +923001234567@phone.mint.invalid. The second is cheaper today and is a lie
-- that leaks into receipts, support tooling, exports and any future mailshot
-- — every one of which would have to learn to recognise a fake domain. The
-- first is honest and the cost is paid once, here.
--
-- The unique index does not change. Postgres already treats NULLs as distinct
-- in a unique index, so any number of rows may have no address while two rows
-- still cannot share one.

ALTER TABLE consumer.users
  ALTER COLUMN email DROP NOT NULL;
--> statement-breakpoint

-- But an account with neither is not an account.
--
-- Nothing could sign in to it, nothing could reach the person, and support
-- would have no way to recognise them. The constraint is what stops a future
-- code path creating one by omission — which is exactly the bug that would
-- otherwise be found months later, as a row nobody can explain.
--
-- NOT VALID so the statement takes no table-wide lock and does not have to
-- scan 7,000 rows behind one: every existing row satisfies it anyway, since
-- email was NOT NULL until a moment ago. New and updated rows are checked
-- from here on, which is the part that matters.
ALTER TABLE consumer.users
  ADD CONSTRAINT users_need_a_credential
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL) NOT VALID;
