/**
 * Client telemetry, the first model moved off Mongo.
 *
 * The behaviour worth pinning here is not "Postgres works" — it is that the
 * route above cannot tell which store answered, and that rows Mongo accepted
 * still land once a CHECK constraint is in the way. Those are the two things
 * that break a cutover.
 *
 * jest.setup.js unsets DATABASE_URL, so these run against the Mongo side by
 * default and never reach live Supabase.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/logs/route";
import * as repository from "@/lib/repositories/logs";
import { buildConditions, toRow } from "@/lib/repositories/logs";

const VALID = {
  event: "app.opened",
  deviceId: "device-1",
  platform: "ios",
  appVersion: "1.4.0",
  buildNumber: "104",
};

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/logs", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

describe("mapping a log into a row", () => {
  it("keeps a level the constraint accepts", () => {
    expect(toRow({ ...VALID, level: "error", timestamp: new Date() }).level).toBe(
      "error",
    );
  });

  it("lowercases before judging", () => {
    expect(toRow({ ...VALID, level: "WARN", timestamp: new Date() }).level).toBe(
      "warn",
    );
  });

  it("coerces a level Mongo accepted but the CHECK would reject", () => {
    // Mongo stored this column as a free string despite the schema's enum, so
    // rows like this exist. Losing the event over its label would be the
    // wrong trade — the event is the useful half.
    expect(
      toRow({ ...VALID, level: "critical", timestamp: new Date() }).level,
    ).toBe("info");
  });

  it("defaults an absent level rather than writing null", () => {
    expect(toRow({ ...VALID, timestamp: new Date() }).level).toBe("info");
  });

  it("defaults an empty device model, which the column requires", () => {
    expect(
      toRow({ ...VALID, deviceModel: "", timestamp: new Date() }).deviceModel,
    ).toBe("unknown");
  });

  it("writes absent optional context as null, not an empty string", () => {
    // The dashboard filters on these. An empty string is a value that matches
    // nothing; null is the absence the query means.
    const row = toRow({ ...VALID, timestamp: new Date() });
    expect(row.userId).toBeNull();
    expect(row.route).toBeNull();
    expect(row.extra).toBeNull();
  });

  it("carries extra through as an object", () => {
    const row = toRow({ ...VALID, timestamp: new Date(), extra: { a: 1 } });
    expect(row.extra).toEqual({ a: 1 });
  });
});

describe("building the filter", () => {
  it("adds nothing when nothing was asked for", () => {
    // An empty filter has to mean "everything", not a WHERE that excludes all.
    expect(buildConditions({})).toHaveLength(0);
  });

  it("adds one condition per supplied field", () => {
    expect(
      buildConditions({ userId: "u", event: "e", route: "/r", level: "warn" }),
    ).toHaveLength(4);
  });

  it("treats a date range as two bounds", () => {
    expect(
      buildConditions({ from: new Date("2026-01-01"), to: new Date("2026-02-01") }),
    ).toHaveLength(2);
  });

  it("allows an open-ended range", () => {
    expect(buildConditions({ from: new Date("2026-01-01") })).toHaveLength(1);
  });
});

describe("the route, whichever store is behind it", () => {
  afterEach(() => jest.restoreAllMocks());

  it("rejects a body missing a required field", async () => {
    const create = jest.spyOn(repository, "createLog");
    const res = await post({ event: "app.opened" });
    expect(res.status).toBe(400);
    // Validation is the route's own job, so nothing should reach the store.
    expect(create).not.toHaveBeenCalled();
  });

  it("stores a valid event", async () => {
    const create = jest
      .spyOn(repository, "createLog")
      .mockResolvedValue(undefined);
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("defaults a missing timestamp to now rather than rejecting", async () => {
    const create = jest
      .spyOn(repository, "createLog")
      .mockResolvedValue(undefined);
    await post(VALID);
    expect(create.mock.calls[0][0].timestamp).toBeInstanceOf(Date);
  });

  it("still answers 201 when the store fails", async () => {
    // The contract the client relies on: logging must never be the reason a
    // request fails. A 500 here would make telemetry an outage.
    jest
      .spyOn(repository, "createLog")
      .mockRejectedValue(new Error("postgres is down"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(VALID);
    expect(res.status).toBe(201);
  });

  it("refuses an unauthenticated read", async () => {
    const res = await GET(new NextRequest("http://localhost/api/logs"));
    expect(res.status).toBe(401);
  });
});

/**
 * The Postgres branch, against a real database.
 *
 * Skipped unless DATABASE_URL_TEST is set, so the default suite never reaches
 * Supabase. Everything above this exercises the Mongo side, which would leave
 * the half that actually ships untested.
 */
describe("the Postgres branch", () => {
  const LIVE = Boolean(process.env.DATABASE_URL);
  const whenLive = LIVE ? describe : describe.skip;

  whenLive("round trip", () => {
    const marker = `test.roundtrip.${Date.now()}`;

    afterAll(async () => {
      const { getPool, closePostgres } = await import("@/lib/postgres");
      await getPool().query("DELETE FROM consumer.logs WHERE event = $1", [
        marker,
      ]);
      await closePostgres();
    });

    it("writes a row and reads the same one back", async () => {
      const when = new Date("2026-09-22T10:00:00.000Z");
      await repository.createLog({
        ...VALID,
        event: marker,
        level: "warn",
        userId: "user-round-trip",
        route: "/profile",
        timestamp: when,
        extra: { nested: { ok: true } },
      });

      const found = await repository.findLogs({ event: marker });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        event: marker,
        level: "warn",
        userId: "user-round-trip",
        route: "/profile",
        deviceModel: "unknown",
        extra: { nested: { ok: true } },
      });
      // The client's clock must survive the trip unchanged — it is what the
      // dashboard sorts by and what an investigator is asking about.
      expect(found[0].timestamp).toBe(when.toISOString());
    });

    it("filters by a date range that excludes the row", async () => {
      const found = await repository.findLogs({
        event: marker,
        to: new Date("2026-01-01T00:00:00.000Z"),
      });
      expect(found).toHaveLength(0);
    });
  });
});
