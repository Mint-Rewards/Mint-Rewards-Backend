# Domain vocabulary

Canonical for all three repos: Mint-Rewards-Backend, Mint-Rewards-BrandHub and
Mint-Rewards-App. Derived from `Mint Definitions.pdf`.

Five words were being used for one or two concepts — Campaign, Deal, Discount,
Offer and Promotion. This file fixes what each means. Use it when naming a
model, a route, a type, a component or a user-facing string.

## The four terms

| Term                    | Means                                                                                                                                                        | The test                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **Brand**               | The consumer-facing identity that sponsors engagement. Logs into BrandHub, runs Campaigns, offers Deals.                                                     | "Who is this from?"                |
| **Campaign**            | A time-bound sustainability/recycling **programme**. The container for collection activity, scoped geographically and in time. **Not** a consumer incentive. | "What programme is this?"          |
| **Deal**                | The umbrella term for any **consumer incentive**. Tied to a Brand.                                                                                           | "What do I get?"                   |
| **Discount**            | **One type** of Deal: a price reduction, by percentage or fixed amount. Not a synonym for Deal.                                                              | "…and it's money off."             |
| **Coupon / promo code** | Only the **redemption mechanism** — the code or voucher tied to a Deal. Never the incentive itself.                                                          | "What do I hand over at checkout?" |

Other Deal types the definitions anticipate but the schema does not yet model:
BOGO, bonus point multipliers, free add-ons, early access, donations. `Deal`
has no type discriminator today, so every deal is implicitly a Discount. That
is a known gap, not a naming decision.

Avoid entirely: **Offer** and **Promotion** as nouns for a Deal. "Avail Offer"
survives as a button label in the app because it reads as a verb phrase and
matches the shipped design.

## Where the code disagrees, deliberately

Three carryovers were left in place rather than renamed, because their names
are a published contract. Each is commented at its definition.

### `CampaignModel` is a Deal

`lib/models.ts` — `CampaignSchema` carries `discountCodes`, `isSingleCode`,
`discountPercentage` and a redeemed-by `users[]`, and has **zero**
recycling-programme fields. Structurally it is a Discount-type Deal.
BrandHub's campaign form confirms it: it captures `campaignType` (General /
Product Launch / Brand Awareness / Seasonal / Influencer Marketing), `budget`
and `targetAudience` — a marketing taxonomy — plus discount % and codes.

Campaign has **no** recycling-programme role anywhere. Actual collection
activity lives in `CollectionModel`, `User.pickupHistory` and
`Brand.environmentalStats`, none of which reference a Campaign.

**Rule going forward: new consumer-incentive work goes on `Deal`.** Do not add
incentive fields to `Campaign`.

### Deprecated consumer routes

Both still serve campaign documents. The mobile app no longer calls either.

| Route                                   | Actually does                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET/PATCH/PUT /api/users/my-discounts` | Reads the **campaigns** collection. Response key `discounts`, body field `discountId`. |
| `PATCH /api/coupons/[couponId]/redeem`  | `couponId` is a **campaign** `_id`.                                                    |

`GET /api/users/active-campaigns` is likewise campaign-backed, and correctly
named for what it returns.

### The app's incentive surface

The app reads **only**:

- `GET /api/users/deals` — active deals from approved brands, with `isAvailed`,
  `soldOut`, and the user's own `code` once claimed. Never returns the full
  `codes` inventory.
- `POST /api/users/deals/[dealId]/redeem` — claims exactly one code, atomically.
  Idempotent per user.

Brand lists on the app's home and brand-detail screens are **derived** from the
deals payload (every deal embeds its brand), not fetched separately.

### `DiscountModel` is gone

There was a `DiscountModel` on the `discounts` collection, imported by zero
routes, scripts and tests. Its shape (`user`, `code`, `isDownloaded`,
`redeemEndTime`) was a per-user _coupon issuance_ record, not a Deal store. It
was deleted rather than renamed. Note this contradicts the definitions PDF,
which describes "Discount" as the model storing Deal records of every type —
that was never true in this repo.

## Naming checklist

Before adding a name, ask:

1. Is it what the consumer **receives**? → **Deal** (or **Discount** only if it
   is specifically a price reduction).
2. Is it the **code or voucher** they redeem? → **coupon** / **promo code**.
3. Is it a **recycling programme** with collection scope and a time window? →
   **Campaign**.
4. Is it none of those? Do not reach for "offer" or "promotion" — name the
   thing.
