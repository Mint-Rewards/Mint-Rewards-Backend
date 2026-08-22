/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import {
  BrandModel,
  BrandUserModel,
  DealModel,
  OrganizationModel,
} from "../lib/models";
import { POST as registerOrg } from "../app/api/brandhub/auth/register/route";
import { PATCH as moderateBrand } from "../app/api/brands/[id]/route";
import { POST as createBrandDeal } from "../app/api/brandhub/brands/[brandId]/deals/route";
import { PATCH as moderateDeal } from "../app/api/brands/[id]/deals/[dealId]/route";
import { GET as getUserDeals } from "../app/api/users/deals/route";
import { POST as redeemDeal } from "../app/api/users/deals/[dealId]/redeem/route";

/**
 * End-to-end, through the real route handlers, of the path a brand actually
 * takes: register in BrandHub -> admin approves the brand -> brand creates
 * deals with codes -> admin approves one deal -> the app lists exactly that
 * deal and can claim a code from it.
 *
 * The claim is what the PDF is built from on the client
 * (hooks/useCouponDownload.ts): it calls the redeem endpoint FIRST and only
 * renders the voucher once a code comes back, so a PDF can never exist for a
 * code the backend never issued.
 */

const brandJsonRequest = (
  url: string,
  token: string,
  body?: unknown,
): NextRequest =>
  new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const adminJsonRequest = (url: string, body: unknown): NextRequest => {
  const token = jwt.sign(
    { email: "admin@example.com", role: "admin" },
    process.env.ADMIN_JWT_SECRET as string,
  );
  return new NextRequest(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

const userRequest = (userId: string, url: string, method = "GET"): Request => {
  const secret =
    process.env.JWT_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.NEXT_JWT_SECRET ||
    "";
  const token = jwt.sign({ id: userId }, secret);
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
};

type AppDeal = {
  _id: string;
  title: string;
  discountPercentage: number | null;
  minimumPurchase: number | null;
  brand: { _id: string; companyName: string };
  isAvailed: boolean;
  code: string | null;
  soldOut: boolean;
  codes?: unknown;
};

describe("BrandHub brand + deals -> app visibility and redemption", () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId().toString();
  const secondUserId = new mongoose.Types.ObjectId().toString();

  let orgId: string;
  let brandId: string;
  let brandToken: string;

  let approvedDealId: string;
  let pendingDealId: string;
  let unapprovedBrandDealId: string;
  let unapprovedBrandId: string;

  const listDeals = async (asUser = userId): Promise<AppDeal[]> => {
    const response = await getUserDeals(
      userRequest(asUser, "http://localhost/api/users/deals"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deals: AppDeal[] };
    return body.deals;
  };

  beforeAll(async () => {
    await connectToDatabase();

    // 1. A brand signs up through BrandHub.
    const registerResponse = await registerOrg(
      new NextRequest("http://localhost/api/brandhub/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgName: `Flow Org ${suffix}`,
          email: `flow-${suffix}@example.com`,
          password: "correct-horse-battery",
          brandName: `Flow Brand ${suffix}`,
        }),
      }),
    );
    expect(registerResponse.status).toBe(201);
    const registered = (await registerResponse.json()) as {
      token: string;
      orgId: string;
      brands: { id: string }[];
    };
    brandToken = registered.token;
    orgId = registered.orgId;
    brandId = registered.brands[0].id;

    // A second brand that never gets approved, to prove brand moderation and
    // deal moderation cannot disagree.
    const unapproved = await BrandModel.create({
      companyName: `Unapproved Co ${suffix}`,
      brandName: `Unapproved Brand ${suffix}`,
      email: `unapproved-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Nobody",
      phone: "0000000000",
      registrationNumber: `UNAPP-${suffix}`,
      status: "PENDING",
      role: "BRAND",
    });
    unapprovedBrandId = unapproved._id.toString();
  });

  afterAll(async () => {
    await Promise.all([
      DealModel.deleteMany({ brand: { $in: [brandId, unapprovedBrandId] } }),
      BrandModel.deleteMany({ _id: { $in: [brandId, unapprovedBrandId] } }),
      BrandUserModel.deleteMany({ email: `flow-${suffix}@example.com` }),
      OrganizationModel.deleteMany({ _id: orgId }),
    ]);
    await mongoose.disconnect();
  });

  it("creates the brand as PENDING, so it is not live before review", async () => {
    const brand = await BrandModel.findById(brandId).lean();
    expect(brand?.status).toBe("PENDING");
  });

  it("admin approves the brand", async () => {
    const response = await moderateBrand(
      adminJsonRequest(`http://localhost/api/brands/${brandId}`, {
        status: "APPROVED",
      }),
      { params: Promise.resolve({ id: brandId }) },
    );
    expect(response.status).toBe(200);
    await expect(BrandModel.findById(brandId).lean()).resolves.toMatchObject({
      status: "APPROVED",
    });
  });

  it("brand creates deals with codes, which start pending", async () => {
    const approved = await createBrandDeal(
      brandJsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals`,
        brandToken,
        {
          title: `Exclusive deal from Flow Brand ${suffix}`,
          codes: ["FLOW-001", "FLOW-002"],
          discountPercentage: 15,
          minimumPurchase: 2000,
        },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(approved.status).toBe(201);
    const approvedBody = (await approved.json()) as {
      deal: { _id: string; status: string; codes: string[]; maxUses: number };
    };
    approvedDealId = approvedBody.deal._id.toString();
    expect(approvedBody.deal.status).toBe("pending");
    expect(approvedBody.deal.codes).toEqual(["FLOW-001", "FLOW-002"]);
    // maxUses is derived from the real code count, never the client's number.
    expect(approvedBody.deal.maxUses).toBe(2);

    const pending = await createBrandDeal(
      brandJsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals`,
        brandToken,
        { title: `Never approved ${suffix}`, codes: ["FLOW-NOPE"] },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(pending.status).toBe(201);
    pendingDealId = (
      (await pending.json()) as { deal: { _id: string } }
    ).deal._id.toString();

    // An ACTIVE deal belonging to a brand that was never approved.
    const orphan = await DealModel.create({
      brand: unapprovedBrandId,
      title: `Deal of an unapproved brand ${suffix}`,
      codes: ["ORPHAN-1"],
      promoCode: "ORPHAN-1",
      maxUses: 1,
      status: "active",
    });
    unapprovedBrandDealId = orphan._id.toString();
  });

  it("shows the user nothing while every deal is still pending", async () => {
    const deals = await listDeals();
    const ids = deals.map((d) => String(d._id));
    expect(ids).not.toContain(approvedDealId);
    expect(ids).not.toContain(pendingDealId);
  });

  it("admin approves one deal", async () => {
    const response = await moderateDeal(
      adminJsonRequest(
        `http://localhost/api/brands/${brandId}/deals/${approvedDealId}`,
        { status: "active" },
      ),
      { params: Promise.resolve({ id: brandId, dealId: approvedDealId }) },
    );
    expect(response.status).toBe(200);
    await expect(
      DealModel.findById(approvedDealId).lean(),
    ).resolves.toMatchObject({
      status: "active",
    });
  });

  it("surfaces ONLY the approved deal of the approved brand", async () => {
    const deals = await listDeals();
    const ids = deals.map((d) => String(d._id));

    expect(ids).toContain(approvedDealId);
    // Still pending — not approved, so not visible.
    expect(ids).not.toContain(pendingDealId);
    // Active deal, but its brand was never approved.
    expect(ids).not.toContain(unapprovedBrandDealId);
  });

  it("carries the fields the app card and ticket render", async () => {
    const deal = (await listDeals()).find(
      (d) => String(d._id) === approvedDealId,
    )!;

    expect(deal.title).toBe(`Exclusive deal from Flow Brand ${suffix}`);
    expect(deal.discountPercentage).toBe(15);
    expect(deal.minimumPurchase).toBe(2000);
    expect(deal.brand.companyName).toBe(`Flow Org ${suffix}`);
    expect(deal.isAvailed).toBe(false);
    expect(deal.soldOut).toBe(false);
    // Unclaimed: no code yet, and the inventory is never handed to the client.
    expect(deal.code).toBeNull();
    expect(deal.codes).toBeUndefined();
  });

  it("issues one real code on claim — the code the PDF is built from", async () => {
    const response = await redeemDeal(
      userRequest(
        userId,
        `http://localhost/api/users/deals/${approvedDealId}/redeem`,
        "POST",
      ),
      { params: Promise.resolve({ dealId: approvedDealId }) },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      code: string;
      alreadyClaimed: boolean;
    };
    expect(["FLOW-001", "FLOW-002"]).toContain(body.code);
    expect(body.alreadyClaimed).toBe(false);
  });

  it("reports the deal as claimed, with that user's own code attached", async () => {
    const deal = (await listDeals()).find(
      (d) => String(d._id) === approvedDealId,
    )!;

    expect(deal.isAvailed).toBe(true);
    expect(["FLOW-001", "FLOW-002"]).toContain(deal.code);
  });

  // The app treats a claim as final, but re-claiming must not burn a second
  // code — that is what makes a failed PDF render recoverable.
  it("is idempotent per user: re-claiming returns the same code", async () => {
    const first = (await listDeals()).find(
      (d) => String(d._id) === approvedDealId,
    )!.code;

    const response = await redeemDeal(
      userRequest(
        userId,
        `http://localhost/api/users/deals/${approvedDealId}/redeem`,
        "POST",
      ),
      { params: Promise.resolve({ dealId: approvedDealId }) },
    );
    const body = (await response.json()) as {
      code: string;
      alreadyClaimed: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.code).toBe(first);
    expect(body.alreadyClaimed).toBe(true);

    const deal = await DealModel.findById(approvedDealId).lean();
    expect(deal?.currentUses).toBe(1);
  });

  it("hands a different user a different code", async () => {
    const mine = (await listDeals()).find(
      (d) => String(d._id) === approvedDealId,
    )!.code;

    const response = await redeemDeal(
      userRequest(
        secondUserId,
        `http://localhost/api/users/deals/${approvedDealId}/redeem`,
        "POST",
      ),
      { params: Promise.resolve({ dealId: approvedDealId }) },
    );
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(200);
    expect(body.code).not.toBe(mine);
    expect(["FLOW-001", "FLOW-002"]).toContain(body.code);
  });

  it("marks the deal sold out for a third user once both codes are gone", async () => {
    const thirdUserId = new mongoose.Types.ObjectId().toString();

    const deal = (await listDeals(thirdUserId)).find(
      (d) => String(d._id) === approvedDealId,
    )!;
    expect(deal.soldOut).toBe(true);

    const response = await redeemDeal(
      userRequest(
        thirdUserId,
        `http://localhost/api/users/deals/${approvedDealId}/redeem`,
        "POST",
      ),
      { params: Promise.resolve({ dealId: approvedDealId }) },
    );
    expect(response.status).toBe(409);
  });
});
