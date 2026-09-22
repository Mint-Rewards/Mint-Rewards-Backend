/**
 * BrandHub: organisations, their logins, and their brands.
 *
 * These three move together and cannot move apart. Signup creates all three
 * inside one Mongo transaction, and the comment above it records why — when
 * they were committed separately, a duplicate brand email returned 409 while
 * leaving a real org and login behind, stranding people with an account
 * holding zero brands after a UI that said signup had failed. No transaction
 * spans Mongo and Postgres, so porting one of the three would rebuild that bug
 * exactly.
 *
 * Primary keys are the Mongo ObjectId hex, stored as text, rather than a new
 * generated id. BrandHub JWTs carry orgId in their payload, and Campaign and
 * Deal still hold brand ObjectIds from Mongo; minting new ids would invalidate
 * every live session and orphan every campaign on the day of the cutover.
 */
import {
  boolean,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { consumer } from "./logs";

/** A 24-character Mongo ObjectId hex, carried over as the key. */
const objectId = (name: string) => text(name);

export const organizations = consumer.table("organizations", {
  id: objectId("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("starter"),
  /**
   * The module catalogue this org has bought, as
   * `[{ module, status, activatedAt, expiresAt }]`.
   *
   * Kept as jsonb rather than a child table: it is read whole on every
   * module-guarded request and never queried across organisations, so a join
   * would cost something on the hot path and buy nothing.
   */
  moduleSubscriptions: jsonb("module_subscriptions")
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const brandUsers = consumer.table(
  "brand_users",
  {
    id: objectId("id").primaryKey(),
    orgId: objectId("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Stored lower-cased, as Mongo's `lowercase: true` did. */
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    orgRole: text("org_role").notNull(),
    /** `[{ module, permissions }]` — read whole, same reasoning as above. */
    moduleAccess: jsonb("module_access")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("brand_users_email_key").on(table.email),
    index("brand_users_org_id_idx").on(table.orgId),
  ],
);

export const brands = consumer.table(
  "brands",
  {
    id: objectId("id").primaryKey(),
    /** Optional: legacy brands predate organisations and must stay valid. */
    orgId: objectId("org_id").references(() => organizations.id),
    /**
     * Set on documents cloned from a legacy brand, pairing this row with its
     * source. Self-referencing, and deliberately not a foreign key: the
     * legacy brand it points at may not have been migrated.
     */
    legacyBrandId: objectId("legacy_brand_id"),

    companyName: text("company_name").notNull(),
    brandName: text("brand_name").notNull(),
    email: text("email").notNull(),
    logo: text("logo"),
    themeImage: text("theme_image"),
    category: text("category").notNull(),
    description: text("description").notNull().default(""),
    address: text("address").notNull().default(""),
    webLink: text("web_link").notNull(),
    appLink: text("app_link").notNull().default(""),
    contactName: text("contact_name").notNull(),
    phone: text("phone").notNull(),
    registrationNumber: text("registration_number").notNull(),
    domain: text("domain").notNull().default(""),
    themeColor: text("theme_color").notNull().default("#3B82F6"),
    status: text("status").notNull().default("PENDING"),
    role: text("role").notNull().default("BRAND"),
    emailVerified: boolean("email_verified").notNull().default(false),
    verificationToken: text("verification_token"),

    /**
     * A single snapshot, and separately a list of dated buckets.
     *
     * Two fields rather than one, carried over deliberately: existing
     * documents hold a lone subdocument in `environmental_stats`, and folding
     * it into the array would break every legacy brand on read. The analytics
     * route prefers buckets and falls back to the snapshot.
     */
    environmentalStats: jsonb("environmental_stats"),
    environmentalPeriods: jsonb("environmental_periods"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("brands_email_key").on(table.email),
    uniqueIndex("brands_registration_number_key").on(table.registrationNumber),
    index("brands_org_id_idx").on(table.orgId),
    index("brands_legacy_brand_id_idx").on(table.legacyBrandId),
    index("brands_status_idx").on(table.status),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
export type BrandUserRow = typeof brandUsers.$inferSelect;
export type NewBrandUserRow = typeof brandUsers.$inferInsert;
export type BrandRow = typeof brands.$inferSelect;
export type NewBrandRow = typeof brands.$inferInsert;
