/**
 * Campaigns and deals on Postgres.
 *
 * See docs/VOCABULARY.md: a Campaign is a recycling programme, a Deal is the
 * incentive a household gets. Documents come back shaped as the Mongo ones
 * were, `_id` and all, for the same reasons as the BrandHub repository —
 * responses hand `_id` to clients, and `ORDER BY id DESC` is what
 * `sort({ _id: -1 })` meant.
 *
 * The one thing here that is not a translation is claimDealCode. On Mongo that
 * was a read, a compare-and-swap, and a retry loop around both. Postgres can
 * do the whole thing in one statement, so it does — see the comment there.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/postgres";
import { campaigns, deals, type CampaignRow, type DealRow } from "@/lib/db/schema";
import type { Executor } from "@/lib/repositories/brandhub";

const exec = (tx?: Executor): Executor => tx ?? getDb();

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// ---------------------------------------------------------------------------
// Document shapes
// ---------------------------------------------------------------------------

export interface CampaignAddress {
  province: string;
  city: string;
  town: string;
}

export interface CampaignDoc {
  _id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  discountCodes: string[];
  isSingleCode: boolean;
  discountPercentage: string | null;
  addresses: CampaignAddress[];
  status: string;
  users: string[];
  brand: string;
  /** The other half of a legacy pairing — see lib/db/schema/deals.ts. */
  brandId: string | null;
  brandRegistration: string;
  description: string | null;
  campaignType: string | null;
  targetAudience: string | null;
  budget: number | null;
  backgroundColor: string | null;
  badge: string | null;
  subtitle: string | null;
  banner: string | null;
}

export interface DealClaim {
  user: string;
  code: string;
  claimedAt: string;
}

export interface DealDoc {
  _id: string;
  brand: string;
  title: string;
  description: string;
  discountPercentage: number | null;
  discountAmount: number | null;
  codes: string[];
  promoCode: string | null;
  startDate: string | null;
  endDate: string | null;
  maxUses: number | null;
  currentUses: number;
  minimumPurchase: number | null;
  status: string;
  users: string[];
  claims: DealClaim[];
  createdAt: Date;
  updatedAt: Date;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toCampaign(row: CampaignRow): CampaignDoc {
  return {
    _id: row.id,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    discountCodes: row.discountCodes ?? [],
    isSingleCode: row.isSingleCode,
    discountPercentage: row.discountPercentage,
    addresses: asArray<CampaignAddress>(row.addresses),
    status: row.status,
    users: row.users ?? [],
    brand: row.brand,
    brandId: row.brandId,
    brandRegistration: row.brandRegistration,
    description: row.description,
    campaignType: row.campaignType,
    targetAudience: row.targetAudience,
    budget: row.budget,
    backgroundColor: row.backgroundColor,
    badge: row.badge,
    subtitle: row.subtitle,
    banner: row.banner,
  };
}

function toDeal(row: DealRow): DealDoc {
  return {
    _id: row.id,
    brand: row.brand,
    title: row.title,
    description: row.description,
    discountPercentage: row.discountPercentage,
    discountAmount: row.discountAmount,
    codes: row.codes ?? [],
    promoCode: row.promoCode,
    startDate: row.startDate,
    endDate: row.endDate,
    maxUses: row.maxUses,
    currentUses: row.currentUses,
    minimumPurchase: row.minimumPurchase,
    status: row.status,
    users: row.users ?? [],
    claims: asArray<DealClaim>(row.claims),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface CampaignFilter {
  brand?: string;
  status?: string;
  /** Everything except EXPIRED, which is the admin list's default. */
  notExpired?: boolean;
}

export async function findCampaignById(
  id: string,
  tx?: Executor,
): Promise<CampaignDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const rows = await exec(tx)
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);
  return rows[0] ? toCampaign(rows[0]) : null;
}

export async function findCampaigns(
  filter: CampaignFilter = {},
  tx?: Executor,
): Promise<CampaignDoc[]> {
  const conditions = [];
  if (filter.brand) conditions.push(eq(campaigns.brand, filter.brand));
  if (filter.status) conditions.push(eq(campaigns.status, filter.status));
  if (filter.notExpired) conditions.push(sql`${campaigns.status} <> 'EXPIRED'`);

  const rows = await exec(tx)
    .select()
    .from(campaigns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(campaigns.id));
  return rows.map(toCampaign);
}

export async function findCampaignsByBrandIds(
  brandIds: readonly string[],
  tx?: Executor,
): Promise<CampaignDoc[]> {
  const valid = [...new Set(brandIds)].filter((id) => OBJECT_ID.test(id));
  if (valid.length === 0) return [];
  const rows = await exec(tx)
    .select()
    .from(campaigns)
    .where(inArray(campaigns.brand, valid))
    .orderBy(desc(campaigns.id));
  return rows.map(toCampaign);
}

export async function createCampaign(
  input: Partial<CampaignDoc> & { name: string; brand: string; _id?: string },
  tx?: Executor,
): Promise<CampaignDoc> {
  const { newObjectId } = await import("@/lib/repositories/brandhub");
  const rows = await exec(tx)
    .insert(campaigns)
    .values({
      id: input._id ?? newObjectId(),
      name: input.name,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      discountCodes: input.discountCodes ?? [],
      isSingleCode: input.isSingleCode ?? false,
      discountPercentage: input.discountPercentage ?? null,
      addresses: input.addresses ?? [],
      status: input.status ?? "PENDING",
      users: input.users ?? [],
      brand: input.brand,
      brandId: input.brandId ?? null,
      brandRegistration: input.brandRegistration ?? "",
      description: input.description ?? null,
      campaignType: input.campaignType ?? null,
      targetAudience: input.targetAudience ?? null,
      budget: input.budget ?? null,
      backgroundColor: input.backgroundColor ?? null,
      badge: input.badge ?? null,
      subtitle: input.subtitle ?? null,
      banner: input.banner ?? null,
    })
    .returning();
  return toCampaign(rows[0]);
}

export async function updateCampaign(
  id: string,
  patch: Partial<Omit<CampaignDoc, "_id">>,
  tx?: Executor,
): Promise<CampaignDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }
  if (Object.keys(values).length === 0) return findCampaignById(id, tx);

  const rows = await exec(tx)
    .update(campaigns)
    .set(values)
    .where(eq(campaigns.id, id))
    .returning();
  return rows[0] ? toCampaign(rows[0]) : null;
}

export async function deleteCampaign(
  id: string,
  tx?: Executor,
): Promise<CampaignDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const rows = await exec(tx)
    .delete(campaigns)
    .where(eq(campaigns.id, id))
    .returning();
  return rows[0] ? toCampaign(rows[0]) : null;
}

/**
 * Marks a campaign redeemed by one person, once.
 *
 * The coupon equivalent of claimDealCode, and simpler: there is no cursor, so
 * the whole operation is "add this person to `users` if they are not already
 * there and the campaign has not expired". One statement, so a second
 * concurrent request for the same person matches nothing and is told the
 * coupon is already used.
 *
 * Returns false for both "already redeemed" and "expired" because the route
 * says the same thing to each — deliberately, so a probe cannot tell a
 * redeemed coupon from an expired one.
 */
export async function claimCampaignForUser(
  campaignId: string,
  userId: string,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(campaignId)) return false;
  const result = await exec(tx).execute(sql`
    UPDATE consumer.campaigns
       SET users = users || ARRAY[${userId}::text]
     WHERE id = ${campaignId}
       AND status <> 'EXPIRED'
       AND NOT (${userId}::text = ANY(users))
    RETURNING id
  `);
  const rows = (result as unknown as { rows: unknown[] }).rows ?? [];
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export interface DealFilter {
  brand?: string;
  status?: string;
  brandIds?: readonly string[];
}

export async function findDealById(
  id: string,
  tx?: Executor,
): Promise<DealDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const rows = await exec(tx)
    .select()
    .from(deals)
    .where(eq(deals.id, id))
    .limit(1);
  return rows[0] ? toDeal(rows[0]) : null;
}

export async function findDeals(
  filter: DealFilter = {},
  tx?: Executor,
): Promise<DealDoc[]> {
  const conditions = [];
  if (filter.brand) conditions.push(eq(deals.brand, filter.brand));
  if (filter.status) conditions.push(eq(deals.status, filter.status));
  if (filter.brandIds) {
    const valid = [...new Set(filter.brandIds)].filter((id) =>
      OBJECT_ID.test(id),
    );
    if (valid.length === 0) return [];
    conditions.push(inArray(deals.brand, valid));
  }

  const rows = await exec(tx)
    .select()
    .from(deals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(deals.id));
  return rows.map(toDeal);
}

export async function createDeal(
  input: Partial<DealDoc> & { brand: string; title: string; _id?: string },
  tx?: Executor,
): Promise<DealDoc> {
  const { newObjectId } = await import("@/lib/repositories/brandhub");
  const rows = await exec(tx)
    .insert(deals)
    .values({
      id: input._id ?? newObjectId(),
      brand: input.brand,
      title: input.title,
      description: input.description ?? "",
      discountPercentage: input.discountPercentage ?? null,
      discountAmount: input.discountAmount ?? null,
      codes: input.codes ?? [],
      promoCode: input.promoCode ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      maxUses: input.maxUses ?? null,
      currentUses: input.currentUses ?? 0,
      minimumPurchase: input.minimumPurchase ?? null,
      status: input.status ?? "pending",
      users: input.users ?? [],
      claims: input.claims ?? [],
    })
    .returning();
  return toDeal(rows[0]);
}

export async function updateDeal(
  id: string,
  patch: Partial<Omit<DealDoc, "_id" | "createdAt">>,
  tx?: Executor,
): Promise<DealDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }
  const rows = await exec(tx)
    .update(deals)
    .set(values)
    .where(eq(deals.id, id))
    .returning();
  return rows[0] ? toDeal(rows[0]) : null;
}

export async function deleteDeal(
  id: string,
  tx?: Executor,
): Promise<DealDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const rows = await exec(tx).delete(deals).where(eq(deals.id, id)).returning();
  return rows[0] ? toDeal(rows[0]) : null;
}

/**
 * Removes campaigns or deals by id.
 *
 * For test teardown, which cleans up after itself the way the Mongo-backed
 * suites did. There is no delete-by-brand: wiping a brand's whole inventory
 * is not something a route should be able to do by passing one argument.
 */
export async function deleteCampaignsByIds(
  ids: readonly string[],
  tx?: Executor,
): Promise<number> {
  const valid = [...new Set(ids)].filter((id) => OBJECT_ID.test(id));
  if (valid.length === 0) return 0;
  const rows = await exec(tx)
    .delete(campaigns)
    .where(inArray(campaigns.id, valid))
    .returning({ id: campaigns.id });
  return rows.length;
}

export async function deleteDealsByIds(
  ids: readonly string[],
  tx?: Executor,
): Promise<number> {
  const valid = [...new Set(ids)].filter((id) => OBJECT_ID.test(id));
  if (valid.length === 0) return 0;
  const rows = await exec(tx)
    .delete(deals)
    .where(inArray(deals.id, valid))
    .returning({ id: deals.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Brand-scoped access
//
// The brand id is part of the WHERE clause, not a check afterwards. It is an
// authorization boundary — one brand must not read or edit another's deal —
// and a boundary enforced by a second statement is one that can be forgotten
// or raced. Mongo expressed it the same way, as `{ _id, brand }`.
// ---------------------------------------------------------------------------

export async function findDealForBrand(
  dealId: string,
  brandId: string,
  tx?: Executor,
): Promise<DealDoc | null> {
  if (!OBJECT_ID.test(dealId)) return null;
  const rows = await exec(tx)
    .select()
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.brand, brandId)))
    .limit(1);
  return rows[0] ? toDeal(rows[0]) : null;
}

/**
 * Updates a deal, optionally appending codes.
 *
 * Same reasoning as the campaign version: the caller cleaned its additions
 * against a pre-read snapshot, so two concurrent calls would each append the
 * overlap. The union happens in the statement instead. Codes are only ever
 * added here — removing one that has already been handed out would leave a
 * claim pointing at nothing.
 */
export async function updateDealForBrand(
  dealId: string,
  brandId: string,
  patch: Partial<Omit<DealDoc, "_id" | "createdAt">>,
  appendCodes?: readonly string[],
  tx?: Executor,
): Promise<DealDoc | null> {
  if (!OBJECT_ID.test(dealId)) return null;
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }

  const toAppend = appendCodes ? [...new Set(appendCodes)] : [];
  if (toAppend.length > 0) {
    values.codes = sql`${deals.codes} || (
      SELECT COALESCE(array_agg(candidate ORDER BY ord), '{}')
      FROM unnest(${sql.param(toAppend)}::text[]) WITH ORDINALITY AS t(candidate, ord)
      WHERE NOT (candidate = ANY(${deals.codes}))
    )`;
  }

  const rows = await exec(tx)
    .update(deals)
    .set(values)
    .where(and(eq(deals.id, dealId), eq(deals.brand, brandId)))
    .returning();
  return rows[0] ? toDeal(rows[0]) : null;
}

export async function deleteDealForBrand(
  dealId: string,
  brandId: string,
  tx?: Executor,
): Promise<DealDoc | null> {
  if (!OBJECT_ID.test(dealId)) return null;
  const rows = await exec(tx)
    .delete(deals)
    .where(and(eq(deals.id, dealId), eq(deals.brand, brandId)))
    .returning();
  return rows[0] ? toDeal(rows[0]) : null;
}

export async function findCampaignForBrand(
  campaignId: string,
  brandId: string,
  tx?: Executor,
): Promise<CampaignDoc | null> {
  if (!OBJECT_ID.test(campaignId)) return null;
  const rows = await exec(tx)
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.brand, brandId)))
    .limit(1);
  return rows[0] ? toCampaign(rows[0]) : null;
}

/**
 * Updates a campaign, optionally appending discount codes.
 *
 * `appendCodes` is Mongo's `$addToSet` with `$each`: codes already present are
 * not added twice, and existing ones are never replaced or removed — a
 * campaign losing its inventory would leave it redeemable with no way to top
 * it up. The append happens in the same statement as the rest of the update so
 * two brand managers adding codes at once cannot overwrite each other, which
 * reading-then-writing in application code would allow.
 */
export async function updateCampaignForBrand(
  campaignId: string,
  brandId: string,
  patch: Partial<Omit<CampaignDoc, "_id">>,
  appendCodes?: readonly string[],
  tx?: Executor,
): Promise<CampaignDoc | null> {
  if (!OBJECT_ID.test(campaignId)) return null;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }

  const toAppend = appendCodes ? [...new Set(appendCodes)] : [];
  if (toAppend.length > 0) {
    // Appended in the order given, minus anything already there, so the
    // existing order — which isSingleCode depends on — is untouched.
    //
    // sql.param, not a bare ${array}: drizzle splats a JS array into separate
    // placeholders, which Postgres reads as a record and refuses to cast to
    // text[].
    values.discountCodes = sql`${campaigns.discountCodes} || (
      SELECT COALESCE(array_agg(candidate ORDER BY ord), '{}')
      FROM unnest(${sql.param(toAppend)}::text[]) WITH ORDINALITY AS t(candidate, ord)
      WHERE NOT (candidate = ANY(${campaigns.discountCodes}))
    )`;
  }

  if (Object.keys(values).length === 0) {
    return findCampaignForBrand(campaignId, brandId, tx);
  }
  const rows = await exec(tx)
    .update(campaigns)
    .set(values)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.brand, brandId)))
    .returning();
  return rows[0] ? toCampaign(rows[0]) : null;
}

export async function deleteCampaignForBrand(
  campaignId: string,
  brandId: string,
  tx?: Executor,
): Promise<CampaignDoc | null> {
  if (!OBJECT_ID.test(campaignId)) return null;
  const rows = await exec(tx)
    .delete(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.brand, brandId)))
    .returning();
  return rows[0] ? toCampaign(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Claiming a code
// ---------------------------------------------------------------------------

export type ClaimOutcome =
  | { status: "claimed"; code: string }
  | { status: "already"; code: string }
  | { status: "exhausted" }
  | { status: "no-codes" }
  | { status: "missing" };

/**
 * Hands one code to one person, once.
 *
 * On Mongo this was a read, a guarded compare-and-swap, and a retry loop
 * around both, because the code to hand out had to be chosen in application
 * code before the update that claimed it. Postgres can pick the code and
 * commit the claim in the same statement, so there is no window to lose and
 * no loop: either the WHERE matches and exactly one claim happens, or it does
 * not match and nothing did.
 *
 * The guards, in order: the deal is active; this person is not already in
 * `users`; and the cursor has not reached the smaller of maxUses and the
 * number of codes.
 *
 * Arrays are 1-based in Postgres, and RETURNING sees the row after the update
 * — so `codes[current_uses]` in RETURNING is the code at the pre-update
 * cursor, which is precisely the one being handed out. That is subtle enough
 * to be worth a test, and it has one.
 */
export async function claimDealCode(
  dealId: string,
  userId: string,
  tx?: Executor,
): Promise<ClaimOutcome> {
  if (!OBJECT_ID.test(dealId)) return { status: "missing" };

  const claimed = await exec(tx).execute(sql`
    UPDATE consumer.deals
       SET current_uses = current_uses + 1,
           users        = users || ARRAY[${userId}::text],
           claims       = claims || jsonb_build_array(jsonb_build_object(
                            'user', ${userId}::text,
                            'code', codes[current_uses + 1],
                            'claimedAt', to_char(
                              now() AT TIME ZONE 'utc',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                          )),
           updated_at   = now()
     WHERE id = ${dealId}
       AND status = 'active'
       AND NOT (${userId}::text = ANY(users))
       AND current_uses < LEAST(
             COALESCE(max_uses, COALESCE(array_length(codes, 1), 0)),
             COALESCE(array_length(codes, 1), 0))
    RETURNING codes[current_uses] AS code
  `);

  const rows = (claimed as unknown as { rows: { code: string }[] }).rows ?? [];
  if (rows.length === 1) return { status: "claimed", code: rows[0].code };

  // Nothing was claimed. Why matters — the caller says different things for
  // "you already have one" and "there are none left" — so this asks, rather
  // than guessing from the failure.
  const deal = await findDealById(dealId, tx);
  if (!deal || deal.status !== "active") return { status: "missing" };

  const mine = deal.claims.find((claim) => claim.user === userId);
  if (mine) return { status: "already", code: mine.code };

  if (deal.codes.length === 0) return { status: "no-codes" };
  return { status: "exhausted" };
}
