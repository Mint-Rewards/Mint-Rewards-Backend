# Signing up with a phone number, verified over WhatsApp

**Status:** planned, not built. 2026-10-06.

**Scope:** people arriving without an email. Nothing here migrates or
re-onboards the users we already have — their phone numbers are untouched, and
the junk among them (212 accounts holding `+92`, 37 holding `555-666-0606`)
stays exactly where it is, because nothing will ever read it as an identity.

## Why

Email is the only identity this system has. In Pakistan that is the wrong one
to insist on: a household signing up at their door has a phone in their hand
and often no email they check. Every signup that stalls at "check your email
for verification" is a household we never collect from.

WhatsApp rather than SMS because the audience already lives there, delivery is
visible to the sender, and a template message is more reliable than an SMS
gateway in the same market.

## The blocker nobody would find until a van failed to turn up

**A phone-only household cannot be collected from.** Not "would be awkward" —
cannot, at all.

The ops map is `user_directory`, and its definition says:

```sql
WHERE u.deleted_at IS NULL
  AND u.email_verified = true      -- <- here
  AND btrim(u.user_name) <> ''
  AND btrim(u.phone) <> ''
```

A household with no email has `email_verified = false` forever, so they never
enter the directory. They cannot be seen on the map, cannot be assigned to a
drive — the assign endpoint checks `emailVerified` a second time, directly —
and cannot be invited. They would sign up, complete their profile, set their
pin, and sit there permanently invisible while believing they are waiting for a
collection.

So this feature does not live in the consumer backend. **The load-bearing
change is in the admin API**, and it is the replacement of "email is verified"
with "SOME credential is verified" in the view and at the two assign checks.

Everything else below is comparatively mechanical.

## The identity model

Add `phone_e164` and `phone_verified_at`.

Leave the existing `phone` column alone. It is what the captain app and the ops
console display, it holds everything a person ever typed, and rewriting it in
place destroys the only record of that. The new column is the verified one and
the only one anything authenticates against.

- **`phone_e164`** — `+923XXXXXXXXX`, written only after a successful OTP
- **unique on `phone_e164` where `phone_verified_at IS NOT NULL`** — a partial
  index, so nothing unverified can ever collide with anything
- a row may carry an email, a phone, or both; any verified credential signs
  them in, and all of them point at **one** row

That last point is not tidiness. Every one-per-person guard in this system is
written against the user id — a deal's code, the referral reward, the signup
grant — and two rows for one person reopens exactly the hole the soft delete
was built to close.

## Email has to become nullable

`email` is `NOT NULL` and unique today. A phone-first signup has nothing to put
there, so either:

1. **Make it nullable.** Honest. Touches every read that assumes an address.
2. **Synthesise** `+923001234567@phone.mint.invalid`. Cheap, and a lie that
   leaks into receipts, support tooling, exports and any future mailshot.

(1) is right and (2) is what gets built under time pressure. The unique index on
email already tolerates nulls in Postgres — several rows may be null — so the
constraint does not have to change, only the NOT NULL.

## Delivering the code over WhatsApp

WhatsApp will not carry arbitrary text to somebody who has not messaged you
first. An OTP goes as an **approved template in the Authentication category**,
through Meta's Cloud API or a Business Solution Provider.

What is needed before any code is useful:

- a Meta Business account with **business verification completed** — document
  review, not instant
- a WhatsApp Business Account and a sender number not already on consumer
  WhatsApp
- an **authentication template approved per language**; Meta fixes the wording
  and you supply the code as a variable
- a payment method, because authentication conversations are billed per country

**Verify the current pricing and policy before committing.** Meta has changed
authentication-category billing repeatedly and Pakistan is among the markets
affected. Any figure written here would be stale by the time it is read.

Cloud API direct is cheaper and one less party; a BSP (Twilio, 360dialog,
Infobip) gets a sender and template approval faster at a markup. For a single
authentication template, direct is defensible — the reason to take a BSP is so
that somebody else owns the approval when it is rejected.

### Rules that must survive implementation

- **Never log the code.** The existing OTP block stores a hash; so must this.
- **Rate limit per number and per IP.** `checkRateLimit` already does both for
  email and needs a number key — otherwise the send button is a way to spend
  our money on somebody else's phone.
- **A paused template is an outage.** If Meta pauses it for quality, every
  phone signup stops. There must be a fallback and it must be exercised before
  it is needed.

## Flows

### Signing up with a number

1. Enter number → normalise to E.164, reject anything that is not a PK mobile
2. Rate limit, send the template
3. Verify → create the row with `phone_e164`, `phone_verified_at`, the 100
   point grant, **no email**
4. Profile completion asks for an email later, optionally and never as a gate

### Signing in with a number

Same two steps, then a **verified** number resolves to its account.

An unknown number must **not** create one silently. This is the same rule we
applied to Google and Apple today, for the same reason: a button that says sign
in must not sign anybody up. Unknown number → offer the signup screen.

### A number that matches somebody already here

4,446 existing accounts carry a parseable number and **none of them is
verified**, so none of them is in the unique index and a new signup will not
collide at the database level. The collision is a person-level one instead: the
same human ends up with two rows, and the guards above stop recognising them.

Verifying a number proves somebody holds the SIM. It does not prove they are
the account holder — the number in that old row may have been mistyped, or be a
shop's. So: do not merge automatically. Attach the number to the existing
account only if they can also satisfy that account's own credential (its
password or its email OTP). Otherwise let the new account stand.

## What is reusable

More than it looks. `setUserOtp`, `recordOtpAttempt` and `consumeOtp` already
take a `which` discriminator mapping to a jsonb column, and all three are
atomic — the burn is guarded on the hash, so a code cannot be spent twice.
`phoneVerification` is a third case, not a new mechanism.

Genuinely new: E.164 normalisation, the WhatsApp client, the template, and the
delivery-failure path.

## Build order

1. **The admin API's notion of "verified"** — the directory view and the two
   assign checks accept a verified phone. Nothing works without this and it is
   invisible from the app, so it is the step most likely to be skipped.
2. `phone_e164`, `phone_verified_at`, the partial unique index, E.164
   normalisation
3. The WhatsApp sender behind an interface, with a logging stub for dev
4. Email nullable
5. Sign up with a number
6. Sign in with a number
7. The duplicate-person policy

Step 1 can ship on its own and changes nothing until a phone-only user exists.
Steps 2–3 likewise. Nothing is user-visible until 5.

## Open decisions

- email nullable, or synthesised addresses (this document argues nullable)
- Cloud API direct, or a BSP
- what happens when a number matches an existing unverified account
- whether a phone-only account can redeem deals, or whether an email is
  required to receive a code
- the fallback when Meta pauses the template, and who is woken up
