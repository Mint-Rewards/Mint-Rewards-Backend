/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { serverEnv } from "../lib/env";
import { BrandModel, CampaignModel, UserModel } from "../lib/models";
import { GET as getMyDiscounts } from "../app/api/users/my-discounts/route";

describe("GET /api/users/my-discounts — city filter", () => {
  let brandId: string;
  let registrationNumber: string;
  let untargetedCampaignId: string;
  let karachiCampaignId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    registrationNumber = `DISCOUNT-CITY-${suffix}`;
    const brand = await BrandModel.create({
      companyName: "Discount City Co",
      brandName: `Discount City Brand ${suffix}`,
      email: `discount-city-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber,
      status: "APPROVED",
    });
    brandId = brand._id.toString();

    const untargeted = await CampaignModel.create({
      name: "Untargeted discount",
      brand: brandId,
      brandRegistration: registrationNumber,
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
    });
    untargetedCampaignId = untargeted._id.toString();

    const karachiOnly = await CampaignModel.create({
      name: "Karachi only discount",
      brand: brandId,
      brandRegistration: registrationNumber,
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      cities: ["Karachi"],
    });
    karachiCampaignId = karachiOnly._id.toString();
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
      UserModel.deleteMany({ _id: { $in: createdUserIds } }),
    ]);
    await mongoose.disconnect();
  });

  async function fetchAsUser(city?: string, avail?: boolean) {
    const suffix = new mongoose.Types.ObjectId().toString();
    const user = await UserModel.create({
      userName: "Discount City Tester",
      email: `discount-city-user-${suffix}@example.com`,
      password: "irrelevant-hash",
      mintId: `MINT-${suffix}`,
      ...(city !== undefined && { city }),
    });
    createdUserIds.push(user._id.toString());

    if (avail) {
      await CampaignModel.updateOne(
        { _id: karachiCampaignId },
        { $addToSet: { users: user._id } },
      );
    }

    const token = jwt.sign({ id: user._id.toString() }, serverEnv.jwtSecret);

    const req = new Request("http://localhost/api/users/my-discounts", {
      headers: { authorization: `Bearer ${token}` },
    });
    const response = await getMyDiscounts(req);
    const body = (await response.json()) as {
      discounts: { _id: string; isAvailed: boolean }[];
    };
    return body.discounts;
  }

  it("shows both discounts to a user in the targeted city", async () => {
    const discounts = await fetchAsUser("Karachi");
    const ids = discounts.map((d) => d._id.toString());
    expect(ids).toEqual(
      expect.arrayContaining([untargetedCampaignId, karachiCampaignId]),
    );
  });

  it("hides the targeted discount from a user in a different city", async () => {
    const discounts = await fetchAsUser("Multan");
    const ids = discounts.map((d) => d._id.toString());
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(karachiCampaignId);
  });

  it("hides the targeted discount from a user with no city set", async () => {
    const discounts = await fetchAsUser(undefined);
    const ids = discounts.map((d) => d._id.toString());
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(karachiCampaignId);
  });

  it("still shows an already-availed targeted discount to a user in a different city", async () => {
    const discounts = await fetchAsUser("Multan", true);
    const karachiDiscount = discounts.find(
      (d) => d._id.toString() === karachiCampaignId,
    );
    expect(karachiDiscount).toBeDefined();
    expect(karachiDiscount?.isAvailed).toBe(true);
  });
});
