/// <reference types="jest" />

/**
 * A brand with more than one premises.
 *
 * The collection pipeline could always express this — a premises is an account
 * under the brand's id, and the directory, zone containment, routing and the
 * ESG roll-up all work per account. The only thing forcing a single one was
 * the code that created exactly one on opt-in, and a dashboard that read
 * `accounts[0]`.
 *
 * What these pin is that the second account is a real, routable, separately
 * pinned door — not a label on the first one — and that the constraints
 * written for people (a unique email, a unique mint id) do not quietly stop a
 * brand having four shops.
 */
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import {
  createBrand,
  createOrganization,
  newObjectId,
} from "../lib/repositories/brandhub";
import { closePostgres, getPool } from "../lib/postgres";
import {
  addBrandCollectionBranch,
  listBrandCollectionAccounts,
  renameBrandCollectionBranch,
  setBrandCollectionPin,
  setBrandWantsCollections,
} from "../lib/repositories/brandCollections";

describe("a brand's premises", () => {
  let brandId: string;
  let neighbourBrandId: string | null = null;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const org = await createOrganization({
      name: `Branches Org ${suffix}`,
      moduleSubscriptions: [
        {
          module: "consumer-reporting",
          status: "active",
          activatedAt: new Date(),
          expiresAt: null,
        },
      ],
    });
    const brand = await createBrand({
      orgId: org._id,
      brandName: `Branches Brand ${suffix}`,
      companyName: "Branches Co",
      email: `branches-${suffix}@example.com`,
      category: "general",
      description: "Integration-test brand",
      address: "1 Test Street",
      webLink: "https://example.com",
      appLink: "",
      contactName: "Test Owner",
      phone: "03001234567",
      registrationNumber: `BR-${suffix}`,
      domain: "",
      status: "APPROVED",
      emailVerified: true,
    });
    brandId = brand._id;
    await setBrandWantsCollections({ brandId, wants: true });
  });

  afterAll(async () => {
    await getPool().query("DELETE FROM consumer.users WHERE brand_id = ANY($1)", [
      [brandId, neighbourBrandId].filter(Boolean),
    ]);
    await closePostgres();
  });

  it("starts with the one account opting in created", async () => {
    const accounts = await listBrandCollectionAccounts(brandId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].hasPin).toBe(false);
  });

  it("adds a second premises, unpinned", async () => {
    /*
     * Unpinned on purpose, exactly as the first is. The brand's address is
     * not good enough: a geocoded street point sends a captain somewhere
     * plausible and nowhere useful, and no-pin-no-collection applies to a
     * warehouse as much as to a house.
     */
    const accounts = await addBrandCollectionBranch({ brandId, name: "Clifton" });
    expect(accounts).toHaveLength(2);
    const clifton = accounts.find((a) => a.name === "Clifton");
    expect(clifton).toBeDefined();
    expect(clifton!.hasPin).toBe(false);
  });

  it("gives each premises its own unique email and mint id", async () => {
    /*
     * `users.email` and `users.mint_id` are both uniquely indexed. The
     * earlier scheme derived both from the BRAND id — the one thing every
     * branch has in common — so a second premises would have collided on a
     * constraint written for people signing up.
     */
    const { rows } = await getPool().query(
      "SELECT email, mint_id FROM consumer.users WHERE brand_id = $1",
      [brandId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r: { email: string }) => r.email)).size).toBe(rows.length);
    expect(new Set(rows.map((r: { mint_id: string }) => r.mint_id)).size).toBe(rows.length);
  });

  it("pins each premises separately", async () => {
    const before = await listBrandCollectionAccounts(brandId);
    const clifton = before.find((a) => a.name === "Clifton")!;

    await setBrandCollectionPin({ brandId, accountId: clifton.id, lat: 24.81, lng: 67.03 });

    const after = await listBrandCollectionAccounts(brandId);
    const pinned = after.find((a) => a.id === clifton.id)!;
    const other = after.find((a) => a.id !== clifton.id)!;
    expect(pinned.hasPin).toBe(true);
    expect(pinned.lat).toBeCloseTo(24.81, 4);
    // The whole point: pinning one door does not move another.
    expect(other.hasPin).toBe(false);
  });

  it("makes each premises routable in its own right", async () => {
    /*
     * `map_pin` at `building` precision is what operations checks before it
     * will schedule anybody. A branch that is not routable is a branch no van
     * is ever sent to, however carefully it was named.
     */
    const { rows } = await getPool().query(
      `SELECT source, precision FROM consumer.users
        WHERE brand_id = $1 AND geog IS NOT NULL`,
      [brandId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("map_pin");
    expect(rows[0].precision).toBe("building");
  });

  it("allows two premises with the same name", async () => {
    /*
     * What a branch is called is the brand's own business — two of their
     * shops may well both be "Clifton", and it is not this system's place to
     * argue. What must not repeat is the PIN.
     */
    const accounts = await addBrandCollectionBranch({ brandId, name: "Clifton" });
    expect(accounts.filter((a) => a.name === "Clifton")).toHaveLength(2);
  });

  it("refuses a second premises pinned to the same spot", async () => {
    /*
     * Two accounts at one gate is two stops on one round at the same door:
     * a captain drives there, is told to collect twice, and the brand reads
     * it as two collections.
     */
    const accounts = await listBrandCollectionAccounts(brandId);
    const pinned = accounts.find((a) => a.hasPin)!;
    const other = accounts.find((a) => !a.hasPin)!;

    await expect(
      setBrandCollectionPin({
        brandId,
        accountId: other.id,
        lat: pinned.lat as number,
        lng: pinned.lng as number,
      }),
    ).rejects.toThrow(/same spot/i);
  });

  it("refuses a pin a few metres away, not just an identical one", async () => {
    /*
     * A brand that forgets to move the map produces the identical
     * coordinate and would be caught either way. One that nudges it a metre
     * and confirms produces a different number for the same gate, and an
     * exact test would wave that through.
     */
    const accounts = await listBrandCollectionAccounts(brandId);
    const pinned = accounts.find((a) => a.hasPin)!;
    const other = accounts.find((a) => !a.hasPin)!;

    await expect(
      setBrandCollectionPin({
        brandId,
        accountId: other.id,
        // ~3 metres north.
        lat: (pinned.lat as number) + 0.00003,
        lng: pinned.lng as number,
      }),
    ).rejects.toThrow(/same spot/i);
  });

  it("allows a pin far enough away to be its own door", async () => {
    const accounts = await listBrandCollectionAccounts(brandId);
    const pinned = accounts.find((a) => a.hasPin)!;
    const other = accounts.find((a) => !a.hasPin)!;

    // ~100 metres north — a different building.
    await setBrandCollectionPin({
      brandId,
      accountId: other.id,
      lat: (pinned.lat as number) + 0.0009,
      lng: pinned.lng as number,
    });
    const after = await listBrandCollectionAccounts(brandId);
    expect(after.filter((a) => a.hasPin).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a nameless premises", async () => {
    await expect(addBrandCollectionBranch({ brandId, name: "   " })).rejects.toThrow();
  });

  it("renames one without touching the others", async () => {
    const before = await listBrandCollectionAccounts(brandId);
    const clifton = before.find((a) => a.name === "Clifton")!;

    const after = await renameBrandCollectionBranch({
      brandId,
      accountId: clifton.id,
      name: "Clifton Depot",
    });
    expect(after.find((a) => a.id === clifton.id)!.name).toBe("Clifton Depot");
    expect(after).toHaveLength(before.length);
  });

  it("lets a DIFFERENT brand pin the same coordinates", async () => {
    /*
     * The rule is per brand, deliberately. Two brands in one building — a
     * mall, an office tower — are two genuine doors that happen to share a
     * roof, and refusing the second would make the vertical case
     * unrepresentable.
     */
    const suffix = new mongoose.Types.ObjectId().toString();
    const org = await createOrganization({
      name: `Neighbour Org ${suffix}`,
      moduleSubscriptions: [
        { module: "consumer-reporting", status: "active", activatedAt: new Date(), expiresAt: null },
      ],
    });
    const neighbour = await createBrand({
      orgId: org._id,
      brandName: `Neighbour Brand ${suffix}`,
      companyName: "Neighbour Co",
      email: `neighbour-${suffix}@example.com`,
      category: "general",
      description: "Same building, different brand",
      address: "1 Test Street",
      webLink: "https://example.com",
      appLink: "",
      contactName: "Test Owner",
      phone: "03007654321",
      registrationNumber: `NB-${suffix}`,
      domain: "",
      status: "APPROVED",
      emailVerified: true,
    });
    neighbourBrandId = neighbour._id;
    await setBrandWantsCollections({ brandId: neighbourBrandId, wants: true });

    const ours = (await listBrandCollectionAccounts(brandId)).find((a) => a.hasPin)!;
    const theirs = (await listBrandCollectionAccounts(neighbourBrandId))[0];

    await setBrandCollectionPin({
      brandId: neighbourBrandId,
      accountId: theirs.id,
      lat: ours.lat as number,
      lng: ours.lng as number,
    });

    const after = await listBrandCollectionAccounts(neighbourBrandId);
    expect(after[0].hasPin).toBe(true);
    expect(after[0].lat).toBeCloseTo(ours.lat as number, 5);
  });

  it("will not let one brand touch another's premises", async () => {
    // An account id alone must not be enough, for the same reason it is not
    // enough to move somebody else's pin.
    const accounts = await listBrandCollectionAccounts(brandId);
    await expect(
      renameBrandCollectionBranch({
        brandId: newObjectId(),
        accountId: accounts[0].id,
        name: "Hijacked",
      }),
    ).rejects.toThrow(/No such collection account/i);
  });

  it("does not create a second account when opting in again", async () => {
    // Idempotent on the way in, and now that branches exist it must also not
    // mistake "two premises" for "not opted in yet".
    const before = await listBrandCollectionAccounts(brandId);
    const result = await setBrandWantsCollections({ brandId, wants: true });
    expect(result.accounts).toHaveLength(before.length);
  });
});
