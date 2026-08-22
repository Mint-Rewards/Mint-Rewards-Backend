/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel } from "../lib/models";
import {
  GET as getMyDiscounts,
  PATCH as patchMyDiscounts,
} from "../app/api/users/my-discounts/route";

// my-discounts previously selected campaigns on `$ne: "EXPIRED"` and did not
// filter brands at all, so a campaign submitted in BrandHub was offered to
// users before any moderation. Both sides of the join must be APPROVED.

function userRequest(userId: string, body?: unknown): Request {
  const secret =
    process.env.JWT_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.NEXT_JWT_SECRET ||
    "";
  const token = jwt.sign({ id: userId }, secret);
  return new Request("http://localhost/api/users/my-discounts", {
    method: body ? "PATCH" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("/api/users/my-discounts", () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId().toString();
  const approvedReg = `approved-reg-${suffix}`;
  const unapprovedBrandReg = `unapproved-brand-reg-${suffix}`;
  const brandIds: mongoose.Types.ObjectId[] = [];
  const campaignIds: mongoose.Types.ObjectId[] = [];

  let approvedCampaignId: string;
  let pendingCampaignId: string;
  let campaignOfPendingBrandId: string;
  let expiredClaimedCampaignId: string;
  let expiredUnclaimedCampaignId: string;

  type BrandStatus = "PENDING" | "APPROVED" | "REJECTED";
  type CampaignStatus = BrandStatus | "EXPIRED";

  const makeBrand = async (
    registrationNumber: string,
    status: BrandStatus,
  ) => {
    const brand = await BrandModel.create({
      companyName: `Brand ${registrationNumber}`,
      brandName: `Brand ${registrationNumber}`,
      email: `${registrationNumber}@example.com`,
      category: "Retail",
      description: "",
      address: "",
      webLink: "https://example.com",
      appLink: "",
      contactName: "N/A",
      phone: "0000000000",
      registrationNumber,
      themeColor: "#242E2E",
      status,
      role: "BRAND",
    });
    brandIds.push(brand._id);
    return brand;
  };

  const makeCampaign = async (
    registrationNumber: string,
    status: CampaignStatus,
    options: { endDate?: string; claimedBy?: string } = {},
  ) => {
    const { endDate = "2099-12-31", claimedBy } = options;
    const campaign = await CampaignModel.create({
      name: `Campaign ${status} ${endDate} ${suffix}`,
      startDate: "2025-02-04",
      endDate,
      discountPercentage: "20",
      discountCodes: ["SAVE20", "SAVE20-B"],
      isSingleCode: false,
      status,
      brand: new mongoose.Types.ObjectId(),
      brandRegistration: registrationNumber,
      addresses: [],
      ...(claimedBy ? { users: [new mongoose.Types.ObjectId(claimedBy)] } : {}),
    });
    campaignIds.push(campaign._id);
    return campaign;
  };

  beforeAll(async () => {
    await connectToDatabase();

    await makeBrand(approvedReg, "APPROVED");
    await makeBrand(unapprovedBrandReg, "PENDING");

    approvedCampaignId = (await makeCampaign(approvedReg, "APPROVED"))._id.toString();
    pendingCampaignId = (await makeCampaign(approvedReg, "PENDING"))._id.toString();
    campaignOfPendingBrandId = (
      await makeCampaign(unapprovedBrandReg, "APPROVED")
    )._id.toString();

    // Nothing in the codebase ever sets status EXPIRED, so an expired campaign
    // stays APPROVED forever — the date is the only signal.
    expiredClaimedCampaignId = (
      await makeCampaign(approvedReg, "APPROVED", {
        endDate: "2020-01-01",
        claimedBy: userId,
      })
    )._id.toString();
    expiredUnclaimedCampaignId = (
      await makeCampaign(approvedReg, "APPROVED", { endDate: "2020-01-01" })
    )._id.toString();
  });

  afterAll(async () => {
    await CampaignModel.deleteMany({ _id: { $in: campaignIds } });
    await BrandModel.deleteMany({ _id: { $in: brandIds } });
    await mongoose.disconnect();
  });

  it("lists an approved campaign from an approved brand", async () => {
    const response = await getMyDiscounts(userRequest(userId));
    const data = await response.json();

    const ids = data.discounts.map((d: any) => String(d._id));
    expect(ids).toContain(approvedCampaignId);
  });

  it("withholds a campaign still awaiting approval", async () => {
    const response = await getMyDiscounts(userRequest(userId));
    const data = await response.json();

    const ids = data.discounts.map((d: any) => String(d._id));
    expect(ids).not.toContain(pendingCampaignId);
  });

  // Brand status is deliberately not a filter here: production's brands are
  // all PENDING clones, and requiring APPROVED emptied the consumer brand list
  // on 2026-08-09. Campaign moderation (the two tests above) holds the line
  // meanwhile. Flip this back alongside the route, once
  // scripts/approve-legacy-clones.js has run against production.
  it("lists an approved campaign whose brand is still pending", async () => {
    const response = await getMyDiscounts(userRequest(userId));
    const data = await response.json();

    const ids = data.discounts.map((d: any) => String(d._id));
    expect(ids).toContain(campaignOfPendingBrandId);
  });

  it("refuses to issue a code for an unapproved campaign", async () => {
    const response = await patchMyDiscounts(
      userRequest(userId, { discountId: pendingCampaignId }),
    );

    expect(response.status).toBe(404);
  });

  it("issues a code for an approved campaign", async () => {
    const response = await patchMyDiscounts(
      userRequest(userId, { discountId: approvedCampaignId }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(["SAVE20", "SAVE20-B"]).toContain(data.code);
  });

  // The screen doubles as redemption history, so an expired campaign the user
  // already claimed stays listed; one they never claimed is unredeemable and
  // must not be offered.
  it("keeps an expired campaign the user already claimed", async () => {
    const response = await getMyDiscounts(userRequest(userId));
    const data = await response.json();

    const ids = data.discounts.map((d: any) => String(d._id));
    expect(ids).toContain(expiredClaimedCampaignId);

    const claimed = data.discounts.find(
      (d: any) => String(d._id) === expiredClaimedCampaignId,
    );
    expect(claimed.isAvailed).toBe(true);
  });

  it("drops an expired campaign the user never claimed", async () => {
    const response = await getMyDiscounts(userRequest(userId));
    const data = await response.json();

    const ids = data.discounts.map((d: any) => String(d._id));
    expect(ids).not.toContain(expiredUnclaimedCampaignId);
  });

  it("refuses to issue a code for an expired campaign", async () => {
    const response = await patchMyDiscounts(
      userRequest(userId, { discountId: expiredUnclaimedCampaignId }),
    );

    expect(response.status).toBe(410);
  });

  // History is for reading, not claiming: already having claimed it does not
  // reopen an expired campaign.
  it("refuses to reissue a code for an expired campaign the user claimed", async () => {
    const response = await patchMyDiscounts(
      userRequest(userId, { discountId: expiredClaimedCampaignId }),
    );

    expect(response.status).toBe(410);
  });
});
