# Campaign City Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let brands peg a campaign to one or more of 7 fixed Pakistani cities, and only show that campaign to users whose profile city matches (or to everyone, if the campaign is untargeted).

**Architecture:** Add a `cities: string[]` field to the existing `Campaign` model (empty = untargeted = visible to all). Validate against a fixed enum on create/edit. Add a pure `isCampaignVisibleToCity` helper and apply it in the three user-facing read endpoints that currently return campaigns unfiltered.

**Tech Stack:** Next.js App Router route handlers, Mongoose, Jest + ts-jest, a real MongoDB test database (`MONGODB_URI_TEST`) — no mocking of the DB layer, per existing test conventions in `__tests__/`.

## Global Constraints

- City list is exactly: `Karachi, Lahore, Islamabad, Faisalabad, Rawalpindi, Multan, Hyderabad` — no others accepted.
- Empty/omitted `cities` on a campaign = untargeted = visible to every user (including users with no city set).
- A user with no `city` set only sees untargeted campaigns, never city-targeted ones.
- Validation on create/edit is strict: any value not in the fixed list is rejected with 400, and nothing is written.
- Filtering applies only to genuine user-facing discovery reads: `GET /api/users/active-campaigns`, `GET /api/users/my-discounts`, and the non-admin branch of `GET /api/brands`. Admin/brand-owner listing endpoints stay unfiltered.
- Do not touch the existing `addresses` field on `Campaign` — it's a separate, unrelated, currently-unused field.

---

### Task 1: City list + validation helper

**Files:**
- Create: `lib/cities.ts`
- Test: `__tests__/cities.test.ts`

**Interfaces:**
- Produces: `TARGETABLE_CITIES: readonly string[]`, `type TargetableCity`, `class InvalidCityError extends Error` (with `invalidValues: string[]`), `function parseTargetCities(raw: unknown): TargetableCity[]`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/cities.test.ts`:

```ts
/// <reference types="jest" />

import { TARGETABLE_CITIES, InvalidCityError, parseTargetCities } from "../lib/cities";

describe("TARGETABLE_CITIES", () => {
  it("is the fixed 7-city list", () => {
    expect(TARGETABLE_CITIES).toEqual([
      "Karachi",
      "Lahore",
      "Islamabad",
      "Faisalabad",
      "Rawalpindi",
      "Multan",
      "Hyderabad",
    ]);
  });
});

describe("parseTargetCities", () => {
  it("returns [] for undefined, null, and empty string", () => {
    expect(parseTargetCities(undefined)).toEqual([]);
    expect(parseTargetCities(null)).toEqual([]);
    expect(parseTargetCities("")).toEqual([]);
  });

  it("accepts a JSON array of valid city names", () => {
    expect(parseTargetCities(["Lahore", "Karachi"])).toEqual(["Lahore", "Karachi"]);
  });

  it("accepts a comma-separated string (multipart/form-data case)", () => {
    expect(parseTargetCities("Lahore, Karachi")).toEqual(["Lahore", "Karachi"]);
  });

  it("trims whitespace and dedupes", () => {
    expect(parseTargetCities([" Lahore ", "Lahore", "Karachi"])).toEqual([
      "Lahore",
      "Karachi",
    ]);
  });

  it("throws InvalidCityError listing every invalid value", () => {
    expect(() => parseTargetCities(["Lahore", "Peshawar", "Quetta"])).toThrow(
      InvalidCityError,
    );
    try {
      parseTargetCities(["Lahore", "Peshawar", "Quetta"]);
      throw new Error("expected parseTargetCities to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCityError);
      expect((err as InvalidCityError).invalidValues).toEqual(["Peshawar", "Quetta"]);
    }
  });

  it("is case-sensitive against the fixed list", () => {
    expect(() => parseTargetCities(["lahore"])).toThrow(InvalidCityError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/cities.test.ts`
Expected: FAIL with "Cannot find module '../lib/cities'"

- [ ] **Step 3: Write minimal implementation**

Create `lib/cities.ts`:

```ts
// Fixed city list for campaign location targeting. Any change here is a
// product decision (which cities Mint Rewards operates in), not a code
// change elsewhere — every validation/filter path reads from this list.
export const TARGETABLE_CITIES = [
  "Karachi",
  "Lahore",
  "Islamabad",
  "Faisalabad",
  "Rawalpindi",
  "Multan",
  "Hyderabad",
] as const;

export type TargetableCity = (typeof TARGETABLE_CITIES)[number];

export class InvalidCityError extends Error {
  invalidValues: string[];

  constructor(invalidValues: string[]) {
    super(`Invalid cities: ${invalidValues.join(", ")}`);
    this.name = "InvalidCityError";
    this.invalidValues = invalidValues;
  }
}

function isTargetableCity(value: string): value is TargetableCity {
  return (TARGETABLE_CITIES as readonly string[]).includes(value);
}

/**
 * Parses a `cities` value from a campaign create/update request body.
 * Accepts a JSON array of strings, or a comma-separated string (request
 * bodies sent as multipart/form-data — required when a banner file is
 * attached — carry every field as a string). Returns [] for
 * undefined/null/empty input, meaning "untargeted".
 *
 * Throws InvalidCityError if any value isn't one of TARGETABLE_CITIES.
 */
export function parseTargetCities(raw: unknown): TargetableCity[] {
  if (raw === undefined || raw === null || raw === "") return [];

  const values: string[] = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : typeof raw === "string"
      ? raw.split(",")
      : [];

  const trimmed = values.map((v) => v.trim()).filter((v) => v.length > 0);
  const deduped = Array.from(new Set(trimmed));

  const invalid = deduped.filter((v) => !isTargetableCity(v));
  if (invalid.length > 0) {
    throw new InvalidCityError(invalid);
  }

  return deduped as TargetableCity[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/cities.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/cities.ts __tests__/cities.test.ts
git commit -m "feat: add fixed city list and target-city parser for campaigns"
```

---

### Task 2: Campaign visibility helper

**Files:**
- Create: `lib/campaignVisibility.ts`
- Test: `__tests__/campaignVisibility.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (kept deliberately independent of the `TargetableCity` type so it works against plain `string[]` from the DB).
- Produces: `function isCampaignVisibleToCity(campaign: { cities?: string[] | null }, userCity?: string | null): boolean`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/campaignVisibility.test.ts`:

```ts
/// <reference types="jest" />

import { isCampaignVisibleToCity } from "../lib/campaignVisibility";

describe("isCampaignVisibleToCity", () => {
  it("is visible to anyone when the campaign has no cities", () => {
    expect(isCampaignVisibleToCity({ cities: [] }, "Lahore")).toBe(true);
    expect(isCampaignVisibleToCity({ cities: [] }, null)).toBe(true);
    expect(isCampaignVisibleToCity({ cities: undefined }, "Lahore")).toBe(true);
    expect(isCampaignVisibleToCity({}, null)).toBe(true);
  });

  it("is visible when the user's city is in the campaign's cities", () => {
    expect(isCampaignVisibleToCity({ cities: ["Lahore", "Karachi"] }, "Lahore")).toBe(
      true,
    );
  });

  it("is hidden when the user's city is not in the campaign's cities", () => {
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, "Karachi")).toBe(false);
  });

  it("is hidden from a user with no city when the campaign is targeted", () => {
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, null)).toBe(false);
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, undefined)).toBe(false);
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, "")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/campaignVisibility.test.ts`
Expected: FAIL with "Cannot find module '../lib/campaignVisibility'"

- [ ] **Step 3: Write minimal implementation**

Create `lib/campaignVisibility.ts`:

```ts
/**
 * True if `campaign` should be shown to a user whose profile city is
 * `userCity`.
 *
 * Rules:
 *   - campaign.cities empty/absent  => untargeted, visible to everyone
 *   - user has no city set          => only untargeted campaigns are visible
 *   - otherwise                     => visible iff userCity is in campaign.cities
 */
export function isCampaignVisibleToCity(
  campaign: { cities?: string[] | null },
  userCity?: string | null,
): boolean {
  const cities = campaign.cities;
  if (!cities || cities.length === 0) return true;
  if (!userCity) return false;
  return cities.includes(userCity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/campaignVisibility.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/campaignVisibility.ts __tests__/campaignVisibility.test.ts
git commit -m "feat: add campaign city visibility helper"
```

---

### Task 3: Add `cities` field to the Campaign model

**Files:**
- Modify: `lib/types.ts:80-100` (the `Campaign` interface)
- Modify: `lib/models.ts:122-162` (the `CampaignSchema`)
- Test: `__tests__/campaignCitiesSchema.test.ts`

**Interfaces:**
- Consumes: `TARGETABLE_CITIES` from `lib/cities.ts` (Task 1), `CampaignModel` from `lib/models.ts` (existing).
- Produces: `Campaign.cities?: string[]` on the type; `CampaignSchema` field `cities: { type: [String], enum: TARGETABLE_CITIES, default: [] }`. Later tasks rely on `cities` existing on every `CampaignDocument`/lean campaign object.

- [ ] **Step 1: Write the failing test**

Create `__tests__/campaignCitiesSchema.test.ts`:

```ts
/// <reference types="jest" />

import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel } from "../lib/models";

describe("Campaign.cities field", () => {
  let brandId: string;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const brand = await BrandModel.create({
      companyName: "Cities Schema Test Co",
      brandName: `Cities Schema Brand ${suffix}`,
      email: `cities-schema-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITIES-SCHEMA-${suffix}`,
      status: "APPROVED",
    });
    brandId = brand._id.toString();
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
    ]);
    await mongoose.disconnect();
  });

  it("defaults to an empty array when not provided", async () => {
    const campaign = await CampaignModel.create({
      name: "Untargeted campaign",
      brand: brandId,
    });
    expect(campaign.cities).toEqual([]);
  });

  it("accepts a subset of the fixed city list", async () => {
    const campaign = await CampaignModel.create({
      name: "Targeted campaign",
      brand: brandId,
      cities: ["Lahore", "Karachi"],
    });
    expect(campaign.cities).toEqual(["Lahore", "Karachi"]);
  });

  it("rejects a city outside the fixed list at the schema level", async () => {
    await expect(
      CampaignModel.create({
        name: "Bad campaign",
        brand: brandId,
        cities: ["Peshawar"],
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/campaignCitiesSchema.test.ts`
Expected: FAIL — the "accepts a subset" case fails because `campaign.cities` is `undefined` (field doesn't exist yet), and the "rejects" case fails because nothing rejects it.

- [ ] **Step 3: Write minimal implementation**

In `lib/types.ts`, add `cities` to the `Campaign` interface (around line 87, next to `addresses`):

```ts
export interface Campaign {
  name: string;
  startDate: string;
  endDate: string;
  discountCodes?: string[];
  isSingleCode?: boolean;
  discountPercentage?: string;
  addresses?: CampaignAddress[];
  cities?: string[];
  status: CampaignStatus;
  users?: Types.ObjectId[];
  brand: Types.ObjectId;
  brandRegistration?: string;
  description?: string;
  campaignType?: string;
  targetAudience?: string;
  budget?: number;
  backgroundColor?: string;
  badge?: string;
  subtitle?: string;
  banner?: string;
}
```

In `lib/models.ts`, add the import and the schema field:

```ts
import { PERMISSION_LEVELS, ORG_ROLES } from "@/lib/modules";
import { TARGETABLE_CITIES } from "@/lib/cities";
```

Inside `CampaignSchema`, add `cities` next to `addresses`:

```ts
const CampaignSchema = new Schema<CampaignDocument>(
  {
    name: stringRequired,
    startDate: String,
    endDate: String,
    discountCodes: { type: [String], default: [] },
    isSingleCode: { type: Boolean, default: false },
    discountPercentage: String,
    addresses: [
      {
        province: stringRequired,
        city: stringRequired,
        town: stringRequired,
        _id: false,
      },
    ],
    cities: {
      type: [String],
      enum: TARGETABLE_CITIES,
      default: [],
    },
    status: {
```
(rest of the schema unchanged)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/campaignCitiesSchema.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/types.ts lib/models.ts __tests__/campaignCitiesSchema.test.ts
git commit -m "feat: add cities field to Campaign schema"
```

---

### Task 4: Accept `cities` on campaign creation (legacy brand route)

**Files:**
- Modify: `app/api/brands/[id]/campaigns/route.ts` (the `POST` handler)
- Test: `__tests__/campaignCitiesCreate.test.ts`

**Interfaces:**
- Consumes: `parseTargetCities`, `InvalidCityError` from `lib/cities.ts` (Task 1).
- Produces: `POST /api/brands/:id/campaigns` now persists `cities` and returns 400 on an invalid city.

- [ ] **Step 1: Write the failing test**

Create `__tests__/campaignCitiesCreate.test.ts` (covers both creation routes — legacy and brandhub):

```ts
/// <reference types="jest" />

import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel, OrganizationModel } from "../lib/models";
import { signBrandToken } from "../lib/brandJwt";
import { POST as createLegacyCampaign } from "../app/api/brands/[id]/campaigns/route";
import { POST as createBrandhubCampaign } from "../app/api/brandhub/brands/[brandId]/campaigns/route";

function jsonRequest(url: string, token: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Campaign creation — cities", () => {
  let orgId: string;
  let brandId: string;
  let brandToken: string;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const org = await OrganizationModel.create({
      name: `Cities Create Test Org ${suffix}`,
      moduleSubscriptions: [
        {
          module: "consumer-reporting",
          status: "active",
          activatedAt: new Date(),
          expiresAt: null,
        },
      ],
    });
    orgId = org._id.toString();

    const brand = await BrandModel.create({
      orgId: org._id,
      brandName: `Cities Create Brand ${suffix}`,
      companyName: "Cities Create Co",
      email: `cities-create-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITIES-CREATE-${suffix}`,
      status: "APPROVED",
    });
    brandId = brand._id.toString();

    brandToken = signBrandToken({
      sub: new mongoose.Types.ObjectId().toString(),
      orgId,
      orgRole: "owner",
      moduleAccess: [],
    });
  });

  afterEach(async () => {
    await CampaignModel.deleteMany({ brand: brandId });
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
      OrganizationModel.deleteOne({ _id: orgId }),
    ]);
    await mongoose.disconnect();
  });

  it("legacy route: creates an untargeted campaign when cities is omitted", async () => {
    const response = await createLegacyCampaign(
      jsonRequest(`http://localhost/api/brands/${brandId}/campaigns`, brandToken, {
        name: "No cities",
      }),
      { params: Promise.resolve({ id: brandId }) },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual([]);
  });

  it("legacy route: creates a campaign with a valid city subset", async () => {
    const response = await createLegacyCampaign(
      jsonRequest(`http://localhost/api/brands/${brandId}/campaigns`, brandToken, {
        name: "Targeted",
        cities: ["Lahore", "Karachi"],
      }),
      { params: Promise.resolve({ id: brandId }) },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual(["Lahore", "Karachi"]);
  });

  it("legacy route: rejects an invalid city with 400 and creates nothing", async () => {
    const before = await CampaignModel.countDocuments({ brand: brandId });
    const response = await createLegacyCampaign(
      jsonRequest(`http://localhost/api/brands/${brandId}/campaigns`, brandToken, {
        name: "Bad",
        cities: ["Peshawar"],
      }),
      { params: Promise.resolve({ id: brandId }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("Peshawar");
    const after = await CampaignModel.countDocuments({ brand: brandId });
    expect(after).toBe(before);
  });

  it("brandhub route: creates a campaign with a valid city subset", async () => {
    const response = await createBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns`,
        brandToken,
        { name: "Brandhub targeted", cities: ["Islamabad"] },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual(["Islamabad"]);
  });

  it("brandhub route: rejects an invalid city with 400", async () => {
    const response = await createBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns`,
        brandToken,
        { name: "Brandhub bad", cities: ["Quetta"] },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("Quetta");
  });
});
```

Note: `requireModuleAccess` (used by the brandhub route) checks the org has an active `consumer-reporting` subscription — the `beforeAll` above already grants it, matching the pattern in `__tests__/brandhubDemoFeatures.test.ts`. `requireBrandAuth`/`requireBrandScope` (used by the legacy route) only check `orgId` match, which the same brand/org satisfies.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/campaignCitiesCreate.test.ts`
Expected: FAIL — both routes currently ignore `cities`, so the "valid subset" tests get `cities: undefined` instead of the expected array, and the "rejects" tests get 201 instead of 400.

- [ ] **Step 3: Write minimal implementation**

In `app/api/brands/[id]/campaigns/route.ts`, add the import:

```ts
import { requireBrandScope } from "@/lib/requireBrandScope";
import { serverEnv } from "@/lib/env";
import { parseTargetCities, InvalidCityError } from "@/lib/cities";
```

In the `POST` handler, after the existing `name` validation block and before `CampaignModel.create`, parse `cities`:

```ts
    const { name, startDate, endDate } = body;

    if (!name || typeof name !== "string" || (name as string).trim() === "") {
      return Response.json(
        { success: false, message: "name is required" },
        { status: 400 },
      );
    }

    let cities: string[];
    try {
      cities = parseTargetCities(body.cities);
    } catch (error) {
      if (error instanceof InvalidCityError) {
        return Response.json(
          { success: false, message: error.message },
          { status: 400 },
        );
      }
      throw error;
    }

    const campaign = await CampaignModel.create({
      name: (name as string).trim(),
      ...(typeof startDate === "string" && startDate && { startDate }),
      ...(typeof endDate === "string" && endDate && { endDate }),
      brand: id,
      brandRegistration: brand.registrationNumber,
      status: "PENDING",
      cities,
      ...(typeof body.description === "string" && { description: body.description }),
```
(the rest of the `create` call is unchanged)

In `app/api/brandhub/brands/[brandId]/campaigns/route.ts`, add the same import:

```ts
import { requireBrandScope } from "@/lib/requireBrandScope";
import { serverEnv } from "@/lib/env";
import { parseTargetCities, InvalidCityError } from "@/lib/cities";
```

And the same validation block, inserted between the `name` validation and `CampaignModel.create`:

```ts
    const { name, startDate, endDate } = body;

    if (!name || typeof name !== "string" || (name as string).trim() === "") {
      return Response.json(
        { success: false, message: "name is required" },
        { status: 400 },
      );
    }

    let cities: string[];
    try {
      cities = parseTargetCities(body.cities);
    } catch (error) {
      if (error instanceof InvalidCityError) {
        return Response.json(
          { success: false, message: error.message },
          { status: 400 },
        );
      }
      throw error;
    }

    const campaign = await CampaignModel.create({
      name: (name as string).trim(),
      ...(typeof startDate === "string" && startDate && { startDate }),
      ...(typeof endDate === "string" && endDate && { endDate }),
      brand: brandId,
      brandRegistration: brand.registrationNumber,
      status: "PENDING",
      cities,
      ...(typeof body.description === "string" && { description: body.description }),
```
(the rest of the `create` call is unchanged)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/campaignCitiesCreate.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/brands/\[id\]/campaigns/route.ts app/api/brandhub/brands/\[brandId\]/campaigns/route.ts __tests__/campaignCitiesCreate.test.ts
git commit -m "feat: validate and persist cities on campaign creation"
```

---

### Task 5: Accept `cities` on campaign edit (both routes)

**Files:**
- Modify: `app/api/brands/[id]/campaigns/[campaignId]/route.ts` (the `PATCH` handler)
- Modify: `app/api/brandhub/brands/[brandId]/campaigns/[campaignId]/route.ts` (the `PATCH` handler)
- Test: `__tests__/campaignCitiesEdit.test.ts`

**Interfaces:**
- Consumes: `parseTargetCities`, `InvalidCityError` from `lib/cities.ts` (Task 1).
- Produces: `PATCH` on both campaign-edit routes now accepts and validates `cities`, independent of the existing `BRAND_EDITABLE` string-field loop.

- [ ] **Step 1: Write the failing test**

Create `__tests__/campaignCitiesEdit.test.ts`:

```ts
/// <reference types="jest" />

import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel, OrganizationModel } from "../lib/models";
import { signBrandToken } from "../lib/brandJwt";
import { PATCH as patchLegacyCampaign } from "../app/api/brands/[id]/campaigns/[campaignId]/route";
import { PATCH as patchBrandhubCampaign } from "../app/api/brandhub/brands/[brandId]/campaigns/[campaignId]/route";

function jsonRequest(url: string, token: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Campaign edit — cities", () => {
  let orgId: string;
  let brandId: string;
  let brandToken: string;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const org = await OrganizationModel.create({
      name: `Cities Edit Test Org ${suffix}`,
      moduleSubscriptions: [
        {
          module: "consumer-reporting",
          status: "active",
          activatedAt: new Date(),
          expiresAt: null,
        },
      ],
    });
    orgId = org._id.toString();

    const brand = await BrandModel.create({
      orgId: org._id,
      brandName: `Cities Edit Brand ${suffix}`,
      companyName: "Cities Edit Co",
      email: `cities-edit-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITIES-EDIT-${suffix}`,
      status: "APPROVED",
    });
    brandId = brand._id.toString();

    brandToken = signBrandToken({
      sub: new mongoose.Types.ObjectId().toString(),
      orgId,
      orgRole: "owner",
      moduleAccess: [],
    });
  });

  afterEach(async () => {
    await CampaignModel.deleteMany({ brand: brandId });
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
      OrganizationModel.deleteOne({ _id: orgId }),
    ]);
    await mongoose.disconnect();
  });

  it("legacy route: updates cities on an existing campaign", async () => {
    const campaign = await CampaignModel.create({ name: "Edit me", brand: brandId });

    const response = await patchLegacyCampaign(
      jsonRequest(
        `http://localhost/api/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Multan", "Hyderabad"] },
      ),
      { params: Promise.resolve({ id: brandId, campaignId: campaign._id.toString() }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual(["Multan", "Hyderabad"]);
  });

  it("legacy route: rejects an invalid city and leaves the campaign unchanged", async () => {
    const campaign = await CampaignModel.create({
      name: "Stays targeted",
      brand: brandId,
      cities: ["Lahore"],
    });

    const response = await patchLegacyCampaign(
      jsonRequest(
        `http://localhost/api/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Peshawar"] },
      ),
      { params: Promise.resolve({ id: brandId, campaignId: campaign._id.toString() }) },
    );
    expect(response.status).toBe(400);

    const unchanged = await CampaignModel.findById(campaign._id).lean();
    expect(unchanged?.cities).toEqual(["Lahore"]);
  });

  it("brandhub route: updates cities and resets status to PENDING", async () => {
    const campaign = await CampaignModel.create({
      name: "Approved, edit cities",
      brand: brandId,
      status: "APPROVED",
    });

    const response = await patchBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Faisalabad"] },
      ),
      {
        params: Promise.resolve({ brandId, campaignId: campaign._id.toString() }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      campaign: { cities: string[]; status: string };
    };
    expect(body.campaign.cities).toEqual(["Faisalabad"]);
    expect(body.campaign.status).toBe("PENDING");
  });

  it("brandhub route: rejects an invalid city", async () => {
    const campaign = await CampaignModel.create({ name: "Bad edit", brand: brandId });

    const response = await patchBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Quetta"] },
      ),
      {
        params: Promise.resolve({ brandId, campaignId: campaign._id.toString() }),
      },
    );
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/campaignCitiesEdit.test.ts`
Expected: FAIL — `cities` isn't in `BRAND_EDITABLE` on either route, so the update is silently dropped (first/third tests get back the old `cities` value) and no invalid-city rejection happens (second/fourth tests get 200 instead of 400, or "No valid fields provided" 400 with the wrong message, but the persisted-value assertions fail either way).

- [ ] **Step 3: Write minimal implementation**

In `app/api/brands/[id]/campaigns/[campaignId]/route.ts`, add the import:

```ts
import { requireBrandScope } from "@/lib/requireBrandScope";
import { serverEnv } from "@/lib/env";
import { parseTargetCities, InvalidCityError } from "@/lib/cities";
```

Deliberately do **not** add `"cities"` to `BRAND_EDITABLE` — it needs validation, not a plain trim. Instead, right after the existing generic field loop and before the `bannerUrl` check, add an explicit block:

```ts
    for (const [key, value] of Object.entries(body)) {
      if (ADMIN_ONLY.has(key)) {
        update[key] = typeof value === "string" ? value.toUpperCase() : value;
      } else if (BRAND_EDITABLE.has(key) && value !== undefined && value !== null) {
        update[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    if (body.cities !== undefined) {
      try {
        update.cities = parseTargetCities(body.cities);
      } catch (error) {
        if (error instanceof InvalidCityError) {
          return Response.json(
            { success: false, message: error.message },
            { status: 400 },
          );
        }
        throw error;
      }
    }

    if (bannerUrl) {
      update.banner = bannerUrl;
    }
```

In `app/api/brandhub/brands/[brandId]/campaigns/[campaignId]/route.ts`, add the same import:

```ts
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";
import { serverEnv } from "@/lib/env";
import { parseTargetCities, InvalidCityError } from "@/lib/cities";
```

And the same explicit block, inserted between its generic `BRAND_EDITABLE` loop and its `if (bannerUrl) { ... }` check — ahead of the existing `update.status = "PENDING";` line, so a cities-only edit still resets status like every other brand edit does:

```ts
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (BRAND_EDITABLE.has(key) && value !== undefined && value !== null) {
        update[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    if (body.cities !== undefined) {
      try {
        update.cities = parseTargetCities(body.cities);
      } catch (error) {
        if (error instanceof InvalidCityError) {
          return Response.json(
            { success: false, message: error.message },
            { status: 400 },
          );
        }
        throw error;
      }
    }

    if (bannerUrl) {
      update.banner = bannerUrl;
    }

    if (Object.keys(update).length === 0) {
      return Response.json(
        { success: false, message: "No valid fields provided" },
        { status: 400 },
      );
    }

    // Any successful brand-initiated edit sends the campaign back through
    // moderation — approved campaigns included. Admin approve/reject stays
    // on the legacy admin PATCH path and is unaffected.
    update.status = "PENDING";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/campaignCitiesEdit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/brands/\[id\]/campaigns/\[campaignId\]/route.ts app/api/brandhub/brands/\[brandId\]/campaigns/\[campaignId\]/route.ts __tests__/campaignCitiesEdit.test.ts
git commit -m "feat: validate and persist cities on campaign edit"
```

---

### Task 6: Filter `GET /api/users/active-campaigns` by user city

**Files:**
- Modify: `app/api/users/active-campaigns/route.ts`
- Test: `__tests__/activeCampaignsCityFilter.test.ts`

**Interfaces:**
- Consumes: `isCampaignVisibleToCity` from `lib/campaignVisibility.ts` (Task 2), `UserModel` (existing, from `lib/models.ts`).
- Produces: `activeCampaigns` in the JSON response is filtered to campaigns visible to the requesting user's city.

- [ ] **Step 1: Write the failing test**

Create `__tests__/activeCampaignsCityFilter.test.ts`:

```ts
/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { serverEnv } from "../lib/env";
import { BrandModel, CampaignModel, UserModel } from "../lib/models";
import { GET as getActiveCampaigns } from "../app/api/users/active-campaigns/route";

describe("GET /api/users/active-campaigns — city filter", () => {
  let brandId: string;
  let untargetedCampaignId: string;
  let lahoreCampaignId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const brand = await BrandModel.create({
      companyName: "City Filter Co",
      brandName: `City Filter Brand ${suffix}`,
      email: `city-filter-brand-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITY-FILTER-${suffix}`,
      status: "APPROVED",
    });
    brandId = brand._id.toString();

    const untargeted = await CampaignModel.create({
      name: "Untargeted",
      brand: brandId,
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
    });
    untargetedCampaignId = untargeted._id.toString();

    const lahoreOnly = await CampaignModel.create({
      name: "Lahore only",
      brand: brandId,
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      cities: ["Lahore"],
    });
    lahoreCampaignId = lahoreOnly._id.toString();
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
      userName: "City Filter Tester",
      email: `city-filter-user-${suffix}@example.com`,
      password: "irrelevant-hash",
      mintId: `MINT-${suffix}`,
      ...(city !== undefined && { city }),
    });
    createdUserIds.push(user._id.toString());
    const token = jwt.sign({ id: user._id.toString() }, serverEnv.jwtSecret);

    const req = new Request("http://localhost/api/users/active-campaigns", {
      headers: { authorization: `Bearer ${token}` },
    });
    const response = await getActiveCampaigns(req);
    const body = (await response.json()) as {
      activeCampaigns: { _id: string }[];
    };
    return body.activeCampaigns.map((c) => c._id.toString());
  }

  it("shows both campaigns to a user in the targeted city", async () => {
    const ids = await fetchAsUser("Lahore");
    expect(ids).toEqual(
      expect.arrayContaining([untargetedCampaignId, lahoreCampaignId]),
    );
  });

  it("hides the targeted campaign from a user in a different city", async () => {
    const ids = await fetchAsUser("Karachi");
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(lahoreCampaignId);
  });

  it("hides the targeted campaign from a user with no city set", async () => {
    const ids = await fetchAsUser(undefined);
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(lahoreCampaignId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/activeCampaignsCityFilter.test.ts`
Expected: FAIL — the route currently returns every approved+active campaign to every user, so "hides the targeted campaign..." tests find `lahoreCampaignId` in the result.

- [ ] **Step 3: Write minimal implementation**

Modify `app/api/users/active-campaigns/route.ts`:

```ts
import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel, UserModel } from "@/lib/models";
import { isCampaignActive } from "@/lib/campaignDates";
import { isCampaignVisibleToCity } from "@/lib/campaignVisibility";

export async function GET(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await UserModel.findById(userId).select("city").lean();

    const activeBrands = await BrandModel.find({
      status: "APPROVED",
    });

    // APPROVED alone is not enough: an expired-but-still-APPROVED campaign
    // must not be reported as active. Filter by real start/end dates too.
    const approvedCampaigns = await CampaignModel.find({
      status: "APPROVED",
    });
    const activeCampaigns = approvedCampaigns
      .filter((c) => isCampaignActive(c))
      .filter((c) => isCampaignVisibleToCity(c, user?.city));

    return Response.json({
      activeBrands,
      activeCampaigns,
    });
  } catch (error: any) {
    return Response.json(
      {
        error:
          error?.message ||
          "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/activeCampaignsCityFilter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/users/active-campaigns/route.ts __tests__/activeCampaignsCityFilter.test.ts
git commit -m "feat: filter active-campaigns by user city"
```

---

### Task 7: Filter `GET /api/users/my-discounts` by user city

**Files:**
- Modify: `app/api/users/my-discounts/route.ts` (the `GET` handler only)
- Test: `__tests__/myDiscountsCityFilter.test.ts`

**Interfaces:**
- Consumes: `isCampaignVisibleToCity` from `lib/campaignVisibility.ts` (Task 2), `UserModel` (existing).
- Produces: the `discounts` array in the JSON response is filtered to campaigns visible to the requesting user's city.

- [ ] **Step 1: Write the failing test**

Create `__tests__/myDiscountsCityFilter.test.ts`:

```ts
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

  async function fetchAsUser(city?: string) {
    const suffix = new mongoose.Types.ObjectId().toString();
    const user = await UserModel.create({
      userName: "Discount City Tester",
      email: `discount-city-user-${suffix}@example.com`,
      password: "irrelevant-hash",
      mintId: `MINT-${suffix}`,
      ...(city !== undefined && { city }),
    });
    createdUserIds.push(user._id.toString());
    const token = jwt.sign({ id: user._id.toString() }, serverEnv.jwtSecret);

    const req = new Request("http://localhost/api/users/my-discounts", {
      headers: { authorization: `Bearer ${token}` },
    });
    const response = await getMyDiscounts(req);
    const body = (await response.json()) as { discounts: { _id: string }[] };
    return body.discounts.map((d) => d._id.toString());
  }

  it("shows both discounts to a user in the targeted city", async () => {
    const ids = await fetchAsUser("Karachi");
    expect(ids).toEqual(
      expect.arrayContaining([untargetedCampaignId, karachiCampaignId]),
    );
  });

  it("hides the targeted discount from a user in a different city", async () => {
    const ids = await fetchAsUser("Multan");
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(karachiCampaignId);
  });

  it("hides the targeted discount from a user with no city set", async () => {
    const ids = await fetchAsUser(undefined);
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(karachiCampaignId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/myDiscountsCityFilter.test.ts`
Expected: FAIL — `karachiCampaignId` shows up for every user today.

- [ ] **Step 3: Write minimal implementation**

Modify `app/api/users/my-discounts/route.ts`. Add the import and fetch the user's city, then filter before mapping:

```ts
import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, CampaignModel, UserModel } from "@/lib/models";
import { isCampaignVisibleToCity } from "@/lib/campaignVisibility";
import mongoose from "mongoose";

const normalize = (value: unknown) =>
  String(value ?? "").trim().toLowerCase();

export async function GET(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await UserModel.findById(userId).select("city").lean();

    const [campaigns, brands] = await Promise.all([
      CampaignModel.find({ status: { $ne: "EXPIRED" } }).lean(),
      BrandModel.find().lean(),
    ]);

    const brandByRegistration = new Map(
      brands.map((b) => [normalize(b.registrationNumber), b]),
    );

    const discounts = campaigns
      .filter((campaign) => isCampaignVisibleToCity(campaign, user?.city))
      .map((campaign) => {
        const brand = brandByRegistration.get(normalize(campaign.brandRegistration));
        if (!brand) return null;
```
(rest of the `.map(...)` body and the function are unchanged)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/myDiscountsCityFilter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/users/my-discounts/route.ts __tests__/myDiscountsCityFilter.test.ts
git commit -m "feat: filter my-discounts by user city"
```

---

### Task 8: Filter `GET /api/brands` (non-admin branch) by user city

**Files:**
- Modify: `app/api/brands/route.ts`
- Test: `__tests__/brandsCityFilter.test.ts`

**Interfaces:**
- Consumes: `isCampaignVisibleToCity` from `lib/campaignVisibility.ts` (Task 2), `UserModel` (existing).
- Produces: for non-admin callers, each brand's nested `campaigns` array in the response is filtered to campaigns visible to the requesting user's city. The admin branch (`isAdmin === true`) is untouched.

- [ ] **Step 1: Write the failing test**

Create `__tests__/brandsCityFilter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/brandsCityFilter.test.ts`
Expected: FAIL — `rawalpindiCampaignId` shows up for every user today.

- [ ] **Step 3: Write minimal implementation**

Modify `app/api/brands/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel, UserModel } from "@/lib/models";
import { Brand, Campaign } from "@/lib/types";
import { requireAdminAuth } from "@/lib/requireAdminAuth";
import { getAuthenticatedUserId } from "@/lib/auth";
import { isCampaignVisibleToCity } from "@/lib/campaignVisibility";

export async function GET(req: NextRequest) {
  // The mobile app's redeem screen reads this endpoint with an ordinary user
  // token, and shipped clients cannot be force-upgraded — admin-only access
  // here 401s them, which trips the global sign-out in authenticatedFetch.
  // Admins keep the unfiltered list; users get the same PENDING-only slice
  // this endpoint returned before it was gated.
  const admin = requireAdminAuth(req);
  const isAdmin = !(admin instanceof NextResponse);

  let userId: string | null = null;
  if (!isAdmin) {
    userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return NextResponse.json({ error: "No token provided" }, { status: 401 });
    }
  }

  try {
    await connectToDatabase();

    const userCity = isAdmin
      ? undefined
      : (await UserModel.findById(userId).select("city").lean())?.city;

    const normalizeRegistration = (value: unknown) =>
      String(value ?? "")
        .trim()
        .toLowerCase();

    const brands = await BrandModel.find(
      isAdmin ? {} : { status: "PENDING" },
    ).lean<Brand[]>();
    const campaigns = await CampaignModel.find({
      status: { $ne: "EXPIRED" },
    }).lean<Campaign[]>();

    const campaignByRegistration = new Map<string, Campaign[]>();

    for (const campaign of campaigns) {
      if (!isAdmin && !isCampaignVisibleToCity(campaign, userCity)) {
        continue;
      }

      const key = normalizeRegistration(campaign.brandRegistration);

      if (!key) {
        continue;
      }

      if (!campaignByRegistration.has(key)) {
        campaignByRegistration.set(key, []);
      }

      campaignByRegistration.get(key)!.push(campaign);
    }

    const brandsWithCampaigns: (Brand & { campaigns: Campaign[] })[] =
      brands.map((brand) => {
        const key = normalizeRegistration(brand.registrationNumber);
        const campaigns = key ? campaignByRegistration.get(key) : undefined;
        return { ...brand, campaigns: campaigns || [] };
      });

    return Response.json({
      success: true,
      brands: brandsWithCampaigns,
    });
  } catch (error: any) {
    return Response.json(
      {
        success: false,
        message: "Server error",
        error: error?.message || "Unexpected error",
      },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/brandsCityFilter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/brands/route.ts __tests__/brandsCityFilter.test.ts
git commit -m "feat: filter brands campaigns by user city for non-admin callers"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx jest`
Expected: every suite passes, including all pre-existing tests (`health`, `auth`, `mailRedirect`, `requireModuleAccess`, `delete-account`, `brandhubDemoFeatures`) and all suites added in Tasks 1–8.

- [ ] **Step 2: Run the TypeScript compiler**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Fix any regressions found**

If either command surfaces a failure introduced by this feature (not a pre-existing failure), fix it in the relevant task's files and re-run both commands until clean. Do not touch unrelated pre-existing failures — note them for the user instead of "fixing" them as part of this feature.

- [ ] **Step 4: Update graphify**

Per this project's `CLAUDE.md`, run `graphify update .` if `graphify-out/graph.json` exists, to keep the knowledge graph current after these code changes. If `graphify-out/` doesn't exist in this repo, skip this step.

No commit for this task — it's verification of the commits already made in Tasks 1–8.
