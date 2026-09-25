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
    })
    .from(users)
    .where(and(eq(users.brandId, brandId), eq(users.accountType, "BRAND")));
  return rows.map((r: { id: string; name: string; phone: string; hasPin: unknown }) => ({
    ...r,
    hasPin: Boolean(r.hasPin),
  }));
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
      await getDb().insert(users).values({
        id: newObjectId(),
        userName: brand.brandName || brand.companyName || "Brand",
        // Suffixed so it cannot collide with the brand's own BrandHub login
        // or with a person who signed up with the same address.
        email: `collections+${input.brandId}@brands.mintrewards.app`,
        password: "",
        mintId: `BRAND-${input.brandId.slice(-8).toUpperCase()}`,
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
