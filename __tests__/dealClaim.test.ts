/**
 * Handing out discount codes.
 *
 * This is the one place in the codebase where a race does not cost a redraw
 * or a stale badge — it hands two people the same code, or burns one nobody
 * receives. So it is tested against a real database with real concurrency
 * rather than asserted in the abstract.
 *
 * Skipped unless DATABASE_URL_TEST is set; jest.setup.js unsets DATABASE_URL
 * otherwise so a default run never reaches Supabase.
 */
import { claimDealCode, createDeal, deleteDeal, findDealById } from "@/lib/repositories/deals";
import { newObjectId } from "@/lib/repositories/brandhub";

const LIVE = Boolean(process.env.DATABASE_URL);
const whenLive = LIVE ? describe : describe.skip;

const madeDeals: string[] = [];

async function makeDeal(codes: string[], extra: Record<string, unknown> = {}) {
  const deal = await createDeal({
    brand: newObjectId(),
    title: `claim-test-${Date.now()}`,
    codes,
    status: "active",
    ...extra,
  });
  madeDeals.push(deal._id);
  return deal;
}

whenLive("claiming a code", () => {
  afterAll(async () => {
    for (const id of madeDeals) await deleteDeal(id);
    const { closePostgres } = await import("@/lib/postgres");
    await closePostgres();
  });

  it("hands out the first code first", async () => {
    // Postgres arrays are 1-based and RETURNING sees the row after the
    // update, so the indexing here is easy to get off by one. This is the
    // test that says which code a first claimant gets.
    const deal = await makeDeal(["AAA", "BBB", "CCC"]);
    const result = await claimDealCode(deal._id, newObjectId());
    expect(result).toEqual({ status: "claimed", code: "AAA" });
  });

  it("advances the cursor by exactly one", async () => {
    const deal = await makeDeal(["AAA", "BBB", "CCC"]);
    await claimDealCode(deal._id, newObjectId());
    const after = await findDealById(deal._id);
    expect(after?.currentUses).toBe(1);
    expect(after?.claims).toHaveLength(1);
    expect(after?.users).toHaveLength(1);
  });

  it("hands successive claimants successive codes", async () => {
    const deal = await makeDeal(["AAA", "BBB", "CCC"]);
    const first = await claimDealCode(deal._id, newObjectId());
    const second = await claimDealCode(deal._id, newObjectId());
    const third = await claimDealCode(deal._id, newObjectId());
    expect([first, second, third]).toEqual([
      { status: "claimed", code: "AAA" },
      { status: "claimed", code: "BBB" },
      { status: "claimed", code: "CCC" },
    ]);
  });

  it("never gives two concurrent claimants the same code", async () => {
    // The whole reason this file exists. Twenty claimants, five codes: five
    // must win with five different codes, and fifteen must be told it is
    // exhausted. Any duplicate here is a discount code issued twice.
    const codes = ["C1", "C2", "C3", "C4", "C5"];
    const deal = await makeDeal(codes);
    const users = Array.from({ length: 20 }, () => newObjectId());

    const results = await Promise.all(
      users.map((user) => claimDealCode(deal._id, user)),
    );

    const won = results.filter((r) => r.status === "claimed");
    const issued = won.map((r) => (r as { code: string }).code);

    expect(won).toHaveLength(5);
    expect(new Set(issued).size).toBe(5);
    expect([...issued].sort()).toEqual(codes);
    expect(results.filter((r) => r.status === "exhausted")).toHaveLength(15);

    const after = await findDealById(deal._id);
    expect(after?.currentUses).toBe(5);
    expect(after?.claims).toHaveLength(5);
  });

  it("gives one person the same code twice rather than two codes", async () => {
    // Re-opening a claimed deal has to be idempotent: the person sees their
    // code again, and the inventory does not move.
    const deal = await makeDeal(["AAA", "BBB"]);
    const user = newObjectId();
    const first = await claimDealCode(deal._id, user);
    const again = await claimDealCode(deal._id, user);

    expect(first).toEqual({ status: "claimed", code: "AAA" });
    expect(again).toEqual({ status: "already", code: "AAA" });

    const after = await findDealById(deal._id);
    expect(after?.currentUses).toBe(1);
  });

  it("is idempotent under concurrency for one person", async () => {
    // A double-tap on a slow connection fires two identical requests.
    const deal = await makeDeal(["AAA", "BBB", "CCC"]);
    const user = newObjectId();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimDealCode(deal._id, user)),
    );

    expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
    const codes = new Set(
      results
        .filter((r) => r.status === "claimed" || r.status === "already")
        .map((r) => (r as { code: string }).code),
    );
    expect(codes).toEqual(new Set(["AAA"]));

    const after = await findDealById(deal._id);
    expect(after?.currentUses).toBe(1);
  });

  it("stops at maxUses even with codes left over", async () => {
    const deal = await makeDeal(["AAA", "BBB", "CCC", "DDD"], { maxUses: 2 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimDealCode(deal._id, newObjectId())),
    );
    expect(results.filter((r) => r.status === "claimed")).toHaveLength(2);
    expect((await findDealById(deal._id))?.currentUses).toBe(2);
  });

  it("refuses a deal with no codes", async () => {
    const deal = await makeDeal([]);
    expect(await claimDealCode(deal._id, newObjectId())).toEqual({
      status: "no-codes",
    });
  });

  it("refuses a deal that is not active", async () => {
    const deal = await makeDeal(["AAA"], { status: "pending" });
    expect(await claimDealCode(deal._id, newObjectId())).toEqual({
      status: "missing",
    });
  });

  it("refuses an id that cannot exist, without a round trip", async () => {
    expect(await claimDealCode("not-an-id", newObjectId())).toEqual({
      status: "missing",
    });
  });

  it("refuses a well-formed id that does not exist", async () => {
    expect(await claimDealCode(newObjectId(), newObjectId())).toEqual({
      status: "missing",
    });
  });

  it("does not hand out codes past the end when the cursor is already past it", async () => {
    // The backfill found 12 dev deals whose currentUses exceeds their code
    // inventory — 6 of them active. Those already fail to redeem on Mongo;
    // they must fail here too rather than returning null or throwing.
    const deal = await makeDeal(["AAA"], { currentUses: 5 });
    expect(await claimDealCode(deal._id, newObjectId())).toEqual({
      status: "exhausted",
    });
  });
});
