/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { serverEnv } from "../lib/env";
import { BrandModel, CampaignModel, UserModel } from "../lib/models";
import { GET as getBrands } from "../app/api/brands/route";

describe("GET /api/brands — city filter (non-admin)", () => {
  let brandId: string;
  let registrationNumber: string;
  let untargetedCampaignId: string;
  let rawalpindiCampaignId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    registrationNumber = `BRANDS-CITY-${suffix}`;
    // Non-admin callers only see PENDING brands from this endpoint
    // (see the comment in app/api/brands/route.ts), so the fixture brand
    // must be PENDING for the assertions to see its campaigns at all.
    const brand = await BrandModel.create({
      companyName: "Brands City Co",
      brandName: `Brands City Brand ${suffix}`,
      email: `brands-city-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber,
      status: "PENDING",
    });
    brandId = brand._id.toString();

    const untargeted = await CampaignModel.create({
      name: "Untargeted brand campaign",
      brand: brandId,
      brandRegistration: registrationNumber,
      status: "APPROVED",
    });
    untargetedCampaignId = untargeted._id.toString();

    const rawalpindiOnly = await CampaignModel.create({
      name: "Rawalpindi only",
      brand: brandId,
      brandRegistration: registrationNumber,
      status: "APPROVED",
      cities: ["Rawalpindi"],
    });
    rawalpindiCampaignId = rawalpindiOnly._id.toString();
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
      UserModel.deleteMany({ _id: { $in: createdUserIds } }),
    ]);
    await mongoose.disconnect();
  });

  async function fetchAsUser(city?: string) {
    const suffix = new mongoose.Types.ObjectId().toString();
    const user = await UserModel.create({
      userName: "Brands City Tester",
      email: `brands-city-user-${suffix}@example.com`,
      password: "irrelevant-hash",
      mintId: `MINT-${suffix}`,
      ...(city !== undefined && { city }),
    });
    createdUserIds.push(user._id.toString());
    const token = jwt.sign({ id: user._id.toString() }, serverEnv.jwtSecret);

    const req = new Request("http://localhost/api/brands", {
      headers: { authorization: `Bearer ${token}` },
    });
    const response = await getBrands(req as any);
    const body = (await response.json()) as {
      brands: { _id: string; campaigns: { _id: string }[] }[];
    };
    const brand = body.brands.find((b) => b._id.toString() === brandId);
    return (brand?.campaigns ?? []).map((c) => c._id.toString());
  }

  it("shows both campaigns to a user in the targeted city", async () => {
    const ids = await fetchAsUser("Rawalpindi");
    expect(ids).toEqual(
      expect.arrayContaining([untargetedCampaignId, rawalpindiCampaignId]),
    );
  });

  it("hides the targeted campaign from a user in a different city", async () => {
    const ids = await fetchAsUser("Faisalabad");
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(rawalpindiCampaignId);
  });

  it("hides the targeted campaign from a user with no city set", async () => {
    const ids = await fetchAsUser(undefined);
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(rawalpindiCampaignId);
  });
});
