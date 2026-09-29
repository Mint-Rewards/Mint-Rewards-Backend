/**
 * A brand's collection account.
 *
 * A brand that asks us to collect from them is a consumer of the service as
 * well as a partner in it. The whole collection pipeline is keyed on a user
 * id, so the brand gets an account in `consumer.users` and everything
 * downstream — zone containment, routing, the no-pin-no-collection rule, a
 * household's own history — works on it unchanged.
 *
 * Kept out of `createUser`: that function's job is a person signing up, and
 * the columns here (account_type, brand_id) are ones it deliberately does not
 * expose.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/postgres";
import { brands, users } from "@/lib/db/schema";
import { newObjectId } from "@/lib/repositories/brandhub";

export interface BrandCollectionAccount {
  id: string;
  name: string;
  phone: string;
  hasPin: boolean;
  /** Where the pin is, so reopening the picker starts where they left it. */
  lat: number | null;
  lng: number | null;
}

/** The accounts this brand already holds, if any. */
export async function listBrandCollectionAccounts(
  brandId: string,
): Promise<BrandCollectionAccount[]> {
  const rows = await getDb()
    .select({
      id: users.id,
      name: users.userName,
      phone: users.phone,
      hasPin: sql<boolean>`${users.geog} IS NOT NULL`,
      // Read from geog rather than the latitude/longitude text columns: geog
      // is what operations routes on, so it is the one that must be shown
      // back. The two agree today and this cannot be the place they stop.
      lat: sql<number | null>`ST_Y(${users.geog}::geometry)`,
      lng: sql<number | null>`ST_X(${users.geog}::geometry)`,
    })
    .from(users)
    .where(and(eq(users.brandId, brandId), eq(users.accountType, "BRAND")));
  return rows.map(
    (r: {
      id: string;
      name: string;
      phone: string;
      hasPin: unknown;
      lat: number | null;
      lng: number | null;
    }) => ({
      ...r,
      hasPin: Boolean(r.hasPin),
      lat: r.lat === null ? null : Number(r.lat),
      lng: r.lng === null ? null : Number(r.lng),
    }),
  );
}

/**
 * The synthetic identity every collection account needs.
 *
 * `users.email` and `users.mint_id` are both uniquely indexed, so a brand with
 * several premises cannot share one of either. Both are derived from the
 * account's own id, which is unique by construction — the earlier scheme keyed
 * them off the BRAND id, which is exactly the thing several branches have in
 * common.
 *
 * Nobody signs in with this address. It exists so the row satisfies a
 * constraint written for people, and the `+` suffix keeps it from colliding
 * with the brand's real BrandHub login.
 */
function syntheticIdentity(accountId: string): { email: string; mintId: string } {
  return {
    email: `collections+${accountId}@brands.mintrewards.app`,
    mintId: `BRAND-${accountId.slice(-8).toUpperCase()}`,
  };
}

/**
 * How many premises one brand may register.
 *
 * Not a business rule so much as a guard: this endpoint creates rows in the
 * table the whole consumer app is keyed on, and a loop in a client must not be
 * able to fill it.
 */
export const MAX_BRAND_BRANCHES = 50;

/**
 * Adds another premises for this brand.
 *
 * A branch is not a new kind of thing — it is another account under the same
 * `brand_id`, which is why no schema changed to allow this. Everything
 * downstream already worked per row: the directory lists each door, zone
 * containment asks about each pin, a round takes each as its own stop, and
 * `impact.ts` sums by `brand_id`, so every branch rolls up into one ESG
 * figure without being told to.
 *
 * It starts unpinned, deliberately, exactly as the first account does. The
 * brand's address is not good enough: a geocoded street point sends a captain
 * somewhere plausible and nowhere useful, and the no-pin-no-collection rule is
 * the same for a warehouse as for a house.
 */
export async function addBrandCollectionBranch(input: {
  brandId: string;
  name: string;
}): Promise<BrandCollectionAccount[]> {
  const name = input.name.trim();
  if (!name) throw new Error("A branch needs a name.");

  const [brand] = await getDb()
    .select({ id: brands.id, phone: brands.phone })
    .from(brands)
    .where(eq(brands.id, input.brandId));
  if (!brand) throw new Error("No such brand.");

  const existing = await listBrandCollectionAccounts(input.brandId);
  if (existing.length >= MAX_BRAND_BRANCHES) {
    throw new Error(`A brand can have at most ${MAX_BRAND_BRANCHES} premises.`);
  }
  /*
   * Two premises with the same name are indistinguishable on a captain's
   * list and on the console map, where the name is all there is to go on.
   * Compared case-insensitively because "Clifton" and "clifton" are the same
   * place to everyone except a string comparison.
   */
  if (existing.some((a) => a.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error("You already have a branch with that name.");
  }

  const accountId = newObjectId();
  const identity = syntheticIdentity(accountId);

  await getDb().insert(users).values({
    id: accountId,
    userName: name,
    email: identity.email,
    password: "",
    mintId: identity.mintId,
    phone: brand.phone ?? "",
    address: "",
    // Verified by construction: the brand authenticated to ask for this, and
    // the directory will not list an unverified account at all.
    emailVerified: true,
    accountType: "BRAND",
    brandId: input.brandId,
  });

  return listBrandCollectionAccounts(input.brandId);
}

/**
 * Renames a premises.
 *
 * The name is what an operator and a captain see on the map and in a stop
 * list, so it is worth being able to correct. Scoped to the brand that asked,
 * for the same reason the pin is: an account id alone must not be enough to
 * touch somebody else's row.
 */
export async function renameBrandCollectionBranch(input: {
  brandId: string;
  accountId: string;
  name: string;
}): Promise<BrandCollectionAccount[]> {
  const name = input.name.trim();
  if (!name) throw new Error("A branch needs a name.");

  const existing = await listBrandCollectionAccounts(input.brandId);
  if (
    existing.some(
      (a) => a.id !== input.accountId && a.name.trim().toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new Error("You already have a branch with that name.");
  }

  const updated = await getDb()
    .update(users)
    .set({ userName: name })
    .where(
      and(
        eq(users.id, input.accountId),
        eq(users.brandId, input.brandId),
        eq(users.accountType, "BRAND"),
      ),
    )
    .returning({ id: users.id });

  if (updated.length === 0) throw new Error("No such collection account for this brand.");
  return listBrandCollectionAccounts(input.brandId);
}

/**
 * Switches the brand's opt-in, creating the account the first time.
 *
 * Idempotent on the way in: a brand toggling on twice has one account, not
 * two. Switching off leaves the account alone — collections that already
 * happened are the brand's own record, and deleting the account to honour a
 * toggle would take that history with it.
 *
 * The account starts with no pin. It is deliberately not derived from the
 * brand's free-text address: a geocoded guess is a point on a street, and the
 * hard rule is that a household without a building-level pin cannot be
 * catered for. The brand drops the pin themselves, and until they do the
 * dashboard can say so.
 */
export async function setBrandWantsCollections(input: {
  brandId: string;
  wants: boolean;
}): Promise<{ wantsCollections: boolean; accounts: BrandCollectionAccount[] }> {
  const [brand] = await getDb()
    .select({
      id: brands.id,
      companyName: brands.companyName,
      brandName: brands.brandName,
      email: brands.email,
      phone: brands.phone,
      address: brands.address,
    })
    .from(brands)
    .where(eq(brands.id, input.brandId));
  if (!brand) throw new Error("No such brand.");

  await getDb()
    .update(brands)
    .set({ wantsCollections: input.wants, updatedAt: new Date() })
    .where(eq(brands.id, input.brandId));

  if (input.wants) {
    const existing = await listBrandCollectionAccounts(input.brandId);
    if (existing.length === 0) {
      const accountId = newObjectId();
      const identity = syntheticIdentity(accountId);
      await getDb().insert(users).values({
        id: accountId,
        userName: brand.brandName || brand.companyName || "Brand",
        // Suffixed so it cannot collide with the brand's own BrandHub login
        // or with a person who signed up with the same address.
        email: identity.email,
        password: "",
        mintId: identity.mintId,
        phone: brand.phone ?? "",
        address: brand.address ?? "",
        // Verified by construction: the brand authenticated to ask for this,
        // and the directory will not list an unverified account at all.
        emailVerified: true,
        accountType: "BRAND",
        brandId: input.brandId,
      });
    }
  }

  return {
    wantsCollections: input.wants,
    accounts: await listBrandCollectionAccounts(input.brandId),
  };
}

/**
 * Where the van should actually go.
 *
 * Recorded as `map_pin` at `building` precision, which is what makes the
 * account routable — those exact values are what operations checks before it
 * will schedule anybody. A brand dragging a pin onto their own roof is the
 * same act as a household doing it, and is trusted the same way.
 *
 * Deliberately not derived from the brand's address text: a geocoder returns
 * a point on a street, and a captain sent there arrives somewhere plausible
 * and nowhere useful.
 */
export async function setBrandCollectionPin(input: {
  brandId: string;
  accountId: string;
  lat: number;
  lng: number;
}): Promise<{ accountId: string; lat: number; lng: number }> {
  const updated = await getDb()
    .update(users)
    .set({
      latitude: String(input.lat),
      longitude: String(input.lng),
      geog: sql`ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography`,
      locationPrecision: "building",
      locationSource: "map_pin",
      locationCapturedAt: new Date(),
      locationVersion: sql`${users.locationVersion} + 1`,
    })
    .where(
      and(
        eq(users.id, input.accountId),
        // Scoped to the brand that asked: an account id alone must not be
        // enough to move somebody else's pin.
        eq(users.brandId, input.brandId),
        eq(users.accountType, "BRAND"),
      ),
    )
    .returning({ id: users.id });

  if (updated.length === 0) throw new Error("No such collection account for this brand.");
  return { accountId: input.accountId, lat: input.lat, lng: input.lng };
}
