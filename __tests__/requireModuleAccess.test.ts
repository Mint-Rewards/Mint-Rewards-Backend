/// <reference types="jest" />

// Exercises the full BrandHub RBAC middleware chain against the isolated
// test database (jest.setup.js remaps MONGODB_URI to MONGODB_URI_TEST and
// throws if it is unset — these suites can never touch production data).

import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import connectToDatabase from "../lib/mongodb";
import { OrganizationModel } from "../lib/models";
import { requireModuleAccess } from "../lib/requireModuleAccess";
import { signBrandToken } from "../lib/brandJwt";
import type { BrandJwtPayload } from "../lib/modules";
import { GET as moduleDemoGet } from "../app/api/brandhub/modules/[module]/route";

const DAY = 24 * 60 * 60 * 1000;

function reqWithToken(token?: string): NextRequest {
  return new NextRequest("http://localhost/api/brandhub/test", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function tokenFor(
  orgId: string,
  orgRole: BrandJwtPayload["orgRole"],
  moduleAccess: BrandJwtPayload["moduleAccess"] = [],
): string {
  return signBrandToken({
    sub: new mongoose.Types.ObjectId().toString(),
    orgId,
    orgRole,
    moduleAccess,
  });
}

async function status(result: unknown): Promise<number | null> {
  return result instanceof NextResponse ? result.status : null;
}

describe("requireModuleAccess chain", () => {
  let subscribedOrgId: string;
  let unsubscribedOrgId: string;
  let expiredOrgId: string;

  beforeAll(async () => {
    await connectToDatabase();
    const now = new Date();

    const [subscribed, unsubscribed, expired] = await OrganizationModel.create([
      {
        name: "RMA Test Org (subscribed)",
        moduleSubscriptions: [
          {
            module: "consumer-reporting",
            status: "active",
            activatedAt: now,
            expiresAt: null,
          },
        ],
      },
      { name: "RMA Test Org (unsubscribed)", moduleSubscriptions: [] },
      {
        name: "RMA Test Org (expired)",
        moduleSubscriptions: [
          {
            module: "consumer-reporting",
            status: "active",
            activatedAt: new Date(now.getTime() - 60 * DAY),
            expiresAt: new Date(now.getTime() - 30 * DAY),
          },
        ],
      },
    ]);
    subscribedOrgId = subscribed._id.toString();
    unsubscribedOrgId = unsubscribed._id.toString();
    expiredOrgId = expired._id.toString();
  });

  afterAll(async () => {
    // If beforeAll never got a connection there are no fixtures to remove, and
    // querying anyway throws "before initial connection is complete" — a second
    // failure that buries the one that actually mattered.
    if (mongoose.connection.readyState !== 1) return;
    await OrganizationModel.deleteMany({ name: /^RMA Test Org / });
    await mongoose.disconnect();
  });

  it("returns 401 when no token is provided", async () => {
    const result = await requireModuleAccess(
      reqWithToken(),
      "consumer-reporting",
      "read",
    );
    expect(await status(result)).toBe(401);
  });

  it("returns 402 when the org is not subscribed to the module", async () => {
    const result = await requireModuleAccess(
      reqWithToken(tokenFor(unsubscribedOrgId, "owner")),
      "consumer-reporting",
      "read",
    );
    expect(await status(result)).toBe(402);
  });

  it("lets an owner through regardless of moduleAccess contents", async () => {
    const result = await requireModuleAccess(
      reqWithToken(tokenFor(subscribedOrgId, "owner", [])),
      "consumer-reporting",
      "manage",
    );
    expect(result instanceof NextResponse).toBe(false);
  });

  it("gives an admin the same bypass as an owner", async () => {
    const result = await requireModuleAccess(
      reqWithToken(tokenFor(subscribedOrgId, "admin", [])),
      "consumer-reporting",
      "manage",
    );
    expect(result instanceof NextResponse).toBe(false);
  });

  it("returns 403 for a member with no entry for the module", async () => {
    const result = await requireModuleAccess(
      reqWithToken(tokenFor(subscribedOrgId, "member", [])),
      "consumer-reporting",
      "read",
    );
    expect(await status(result)).toBe(403);
  });

  it("returns 403 for a member with read hitting a write-required check", async () => {
    const result = await requireModuleAccess(
      reqWithToken(
        tokenFor(subscribedOrgId, "member", [
          { module: "consumer-reporting", permissions: ["read"] },
        ]),
      ),
      "consumer-reporting",
      "write",
    );
    expect(await status(result)).toBe(403);
  });

  it("passes a member with write hitting a write-required check", async () => {
    const result = await requireModuleAccess(
      reqWithToken(
        tokenFor(subscribedOrgId, "member", [
          { module: "consumer-reporting", permissions: ["write"] },
        ]),
      ),
      "consumer-reporting",
      "write",
    );
    expect(result instanceof NextResponse).toBe(false);
  });

  it("returns 403 for a member with write hitting a manage-required check", async () => {
    const result = await requireModuleAccess(
      reqWithToken(
        tokenFor(subscribedOrgId, "member", [
          { module: "consumer-reporting", permissions: ["write"] },
        ]),
      ),
      "consumer-reporting",
      "manage",
    );
    expect(await status(result)).toBe(403);
  });

  it("404s an unknown module ID before JWT verification is attempted", async () => {
    // No token at all: if auth ran first this would be a 401 with an
    // "Unauthorized" body. The module-ID gate must win.
    const res = await moduleDemoGet(reqWithToken(), {
      params: Promise.resolve({ module: "not-a-real-module" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Unknown module");
    expect(body.error).not.toMatch(/unauthorized/i);
  });

  it("returns 402 for a subscription past its expiresAt (lazy expiry)", async () => {
    const result = await requireModuleAccess(
      reqWithToken(tokenFor(expiredOrgId, "owner")),
      "consumer-reporting",
      "read",
    );
    expect(await status(result)).toBe(402);
  });
});
