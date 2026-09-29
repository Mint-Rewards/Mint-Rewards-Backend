/**
 * Campaigns and deals — the consumer-facing incentives.
 *
 * See docs/VOCABULARY.md: a Campaign is a recycling programme, a Deal is the
 * incentive a household gets. They are separate tables because they are
 * separate things, despite both carrying codes and both pointing at a brand.
 *
 * `users` and `codes` are `text[]`, not jsonb. The deal-claim path is a
 * compare-and-swap — it matches on the current use count *and* on the claimer
 * not already being in `users`, then appends — and a native array gives that
 * `NOT (users @> ARRAY[$1])` and `users || $1` in one guarded UPDATE. jsonb
 * would work too, but arrays are indexable with GIN and read as what they are.
 *
 * `claims` stays jsonb: it is an append-only log of objects, never searched by
 * element, and a child table would buy a join for nothing.
 */
import { boolean, index, integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { consumer } from "./logs";

export const campaigns = consumer.table(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),

    /**
     * Dates are text, as they were in Mongo.
     *
     * Deliberate: the existing values are whatever the brand portal wrote,
     * and comparisons happen in JS after Date.parse. Retyping to a date column
     * would reject the malformed ones on migration rather than on read, which
     * turns a display problem into a data-loss one.
     */
    startDate: text("start_date"),
    endDate: text("end_date"),

    discountCodes: text("discount_codes").array().notNull().default(sql`'{}'`),
    isSingleCode: boolean("is_single_code").notNull().default(false),
    discountPercentage: text("discount_percentage"),

    /** `[{ province, city, town }]` — read whole, never queried by element. */
    addresses: jsonb("addresses").notNull().default(sql`'[]'::jsonb`),

    status: text("status").notNull().default("PENDING"),

    /** Consumer ids. Still Mongo ObjectIds — User has not moved yet. */
    users: text("users").array().notNull().default(sql`'{}'`),

    /**
     * The owning brand. Not a foreign key to consumer.brands on purpose:
     * campaigns exist whose brand was never migrated, and a constraint would
     * have dropped them at backfill rather than surfacing them.
     */
    brand: text("brand").notNull(),
    /**
     * The other half of a legacy pairing, not the owner.
     *
     * Written by the migration that repointed campaigns from legacy brand
     * documents to their BrandHub clones, and absent from CampaignSchema
     * because Mongoose never knew about it. active-campaigns resolves a
     * repointed campaign through it, so a campaign that loses it goes missing
     * from its brand's card with no error raised.
     */
    brandId: text("brand_id"),
    brandRegistration: text("brand_registration").notNull().default(""),

    description: text("description"),
    campaignType: text("campaign_type"),
    targetAudience: text("target_audience"),
    budget: integer("budget"),
    backgroundColor: text("background_color"),
    badge: text("badge"),
    subtitle: text("subtitle"),
    banner: text("banner"),
  },
  (table) => [
    index("campaigns_brand_idx").on(table.brand),
    index("campaigns_brand_id_idx").on(table.brandId),
    index("campaigns_status_idx").on(table.status),
    index("campaigns_brand_registration_idx").on(table.brandRegistration),
  ],
);

export const deals = consumer.table(
  "deals",
  {
    id: text("id").primaryKey(),
    brand: text("brand").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),

    discountPercentage: integer("discount_percentage"),
    discountAmount: integer("discount_amount"),

    /** Inventory of codes; promoCode mirrors codes[0] for legacy readers. */
    codes: text("codes").array().notNull().default(sql`'{}'`),
    promoCode: text("promo_code"),

    startDate: text("start_date"),
    endDate: text("end_date"),

    maxUses: integer("max_uses"),
    /** The claim cursor. The compare-and-swap matches on this exact value. */
    currentUses: integer("current_uses").notNull().default(0),
    minimumPurchase: integer("minimum_purchase"),

    status: text("status").notNull().default("pending"),

    users: text("users").array().notNull().default(sql`'{}'`),
    /** `[{ user, code, claimedAt }]` — append-only, never searched. */
    claims: jsonb("claims").notNull().default(sql`'[]'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("deals_brand_idx").on(table.brand),
    index("deals_status_idx").on(table.status),
  ],
);

export type CampaignRow = typeof campaigns.$inferSelect;
export type NewCampaignRow = typeof campaigns.$inferInsert;
export type DealRow = typeof deals.$inferSelect;
export type NewDealRow = typeof deals.$inferInsert;
