/**
 * The mirror against real databases, exercising the write shapes the routes
 * actually use. Skipped unless DUAL_WRITE_TEST_POSTGRES_URL is set — CI has no
 * Postgres, and this suite writes to both stores.
 *
 *   docker run -d --name dw-mongo -p 27019:27017 mongo:7
 *   createdb + psql -f scripts/postgres-normalized-schema.sql
 *   MONGODB_URI_TEST=mongodb://localhost:27019/dualwrite_test \
 *   DUAL_WRITE_TEST_POSTGRES_URL=postgres://.../dw_test \
 *     npx jest __tests__/dualWriteIntegration.test.ts
 *
 * The point is the operations, not the mapping: only 8 of the 44 write sites
 * are `.save()`, so anything that passes on documents alone proves nothing.
 */
import mongoose from "mongoose";
import pg from "pg";

const PG_URL = process.env.DUAL_WRITE_TEST_POSTGRES_URL;
const d = PG_URL ? describe : describe.skip;

d("dual-write against real databases", () => {
  let pgc: pg.Client;
  let UserModel: typeof import("@/lib/models").UserModel;

  const rowsFor = async (id: string) =>
    (await pgc.query("SELECT * FROM users WHERE id = $1", [id])).rows;
  const locFor = async (id: string) =>
    (await pgc.query("SELECT * FROM user_locations WHERE user_id = $1", [id])).rows;

  let n = 0;
  const freshUser = () => ({
    userName: `DW User ${++n}`,
    email: `dw-${Date.now()}-${n}@example.pk`,
    password: "hashed-not-mirrored",
    mintId: `DW-${Date.now()}-${n}`,
  });

  beforeAll(async () => {
    process.env.DUAL_WRITE_ENABLED = "true";
    process.env.POSTGRES_URL = PG_URL;
    ({ UserModel } = await import("@/lib/models"));
    await mongoose.connect(process.env.MONGODB_URI as string);
    pgc = new pg.Client({ connectionString: PG_URL });
    await pgc.connect();
    await pgc.query("TRUNCATE users CASCADE");
    await UserModel.deleteMany({ email: /^dw-/ });
  });

  afterAll(async () => {
    await UserModel.deleteMany({ email: /^dw-/ });
    await mongoose.disconnect();
    await pgc.end();
  });

  it("mirrors a document save", async () => {
    const doc = await UserModel.create(freshUser());
    const rows = await rowsFor(String(doc._id));
    expect(rows).toHaveLength(1);
    expect(rows[0].user_name).toBe(doc.userName);
    expect(rows[0].mint_id).toBe(doc.mintId);
  });

  it("mirrors the password hash — Postgres becomes the auth store", async () => {
    // Deliberate. A user who signs up or changes their password during the
    // window must be able to log in after the switch; withholding the hash
    // would strand them, and would hide the loss from reconciliation too.
    const doc = await UserModel.create(freshUser());
    const rows = await rowsFor(String(doc._id));
    expect(rows[0].password).toBe("hashed-not-mirrored");
  });

  it("mirrors findOneAndUpdate — a query write, not a document one", async () => {
    const doc = await UserModel.create(freshUser());
    await UserModel.findOneAndUpdate({ _id: doc._id }, { $set: { userName: "Renamed" } });
    expect((await rowsFor(String(doc._id)))[0].user_name).toBe("Renamed");
  });

  it("mirrors updateOne, whose post hook gets no document at all", async () => {
    const doc = await UserModel.create(freshUser());
    await UserModel.updateOne({ _id: doc._id }, { $set: { points: 250 } });
    expect((await rowsFor(String(doc._id)))[0].points).toBe(250);
  });

  it("mirrors updateMany across several documents", async () => {
    const a = await UserModel.create(freshUser());
    const b = await UserModel.create(freshUser());
    await UserModel.updateMany({ _id: { $in: [a._id, b._id] } }, { $set: { city: "Karachi" } });
    expect((await rowsFor(String(a._id)))[0].city).toBe("Karachi");
    expect((await rowsFor(String(b._id)))[0].city).toBe("Karachi");
  });

  it("translates a dotted $set into the nested child table", async () => {
    const doc = await UserModel.create(freshUser());
    // The exact shape the location routes write, and the case the plan
    // expected to need hand-written column translation.
    await UserModel.updateOne(
      { _id: doc._id },
      {
        $set: {
          "location.type": "Point",
          "location.coordinates": [67.03, 24.86],
          "location.source": "map_pin",
          "location.precision": "building",
          "structuredAddress.cityId": "Karachi",
          locationVersion: 2,
        },
      },
    );
    const loc = await locFor(String(doc._id));
    expect(loc).toHaveLength(1);
    expect(Number(loc[0].lng)).toBeCloseTo(67.03);
    expect(Number(loc[0].lat)).toBeCloseTo(24.86);
    expect(loc[0].source).toBe("map_pin");
    expect(loc[0].structured_city_id).toBe("Karachi");
    expect(loc[0].version).toBe(2);
  });

  it("removes the child row when the location data goes away", async () => {
    const doc = await UserModel.create(freshUser());
    await UserModel.updateOne({ _id: doc._id }, { $set: { locationVersion: 1 } });
    expect(await locFor(String(doc._id))).toHaveLength(1);
    await UserModel.updateOne({ _id: doc._id }, { $unset: { locationVersion: "" } });
    expect(await locFor(String(doc._id))).toHaveLength(0);
  });

  it("mirrors a delete, parent and child together", async () => {
    const doc = await UserModel.create(freshUser());
    await UserModel.updateOne({ _id: doc._id }, { $set: { locationVersion: 3 } });
    expect(await locFor(String(doc._id))).toHaveLength(1);

    await UserModel.findOneAndDelete({ _id: doc._id });
    expect(await rowsFor(String(doc._id))).toHaveLength(0);
    expect(await locFor(String(doc._id))).toHaveLength(0);
  });

  it("mirrors deleteMany", async () => {
    const a = await UserModel.create(freshUser());
    const b = await UserModel.create(freshUser());
    await UserModel.deleteMany({ _id: { $in: [a._id, b._id] } });
    expect(await rowsFor(String(a._id))).toHaveLength(0);
    expect(await rowsFor(String(b._id))).toHaveLength(0);
  });

  // The loop closed: everything above was written through the middleware, and
  // the job that has to certify the window agrees the two stores match. Either
  // half passing alone proves much less than both passing together.
  it("leaves the reconciler with nothing to report", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      process.execPath,
      ["scripts/reconcile-mongo-postgres.mjs", "--json"],
      {
        env: {
          ...process.env,
          RECONCILE_MONGODB_URI: process.env.MONGODB_URI,
          RECONCILE_POSTGRES_URL: PG_URL,
        },
        encoding: "utf8",
      },
    );
    const report = JSON.parse(out);
    expect(report.ok).toBe(true);
    expect(report.tables.users.missingInPg).toBe(0);
    expect(report.tables.users.mismatches).toBe(0);
    expect(report.tables.user_locations.mismatches).toBe(0);
  });
});
