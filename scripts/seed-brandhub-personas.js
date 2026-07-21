// QA persona seed for BrandHub acceptance testing. Creates five independent
// organizations, each exercising a different slice of the product:
//
//   1. Aisha Karim    — solo owner, one populated brand (8 campaigns, 12 deals)
//   2. Marcus Chen    — multi-brand org, 4 brands in mixed states
//   3. Priya Sharma   — fresh registrant, placeholder scaffolding, no data
//   4. Diego Fernández— analytics operator, rich environmentalStats
//   5. Yuki Tanaka    — promotions power user (15 campaigns, 20 deals)
//
// All five share the password "test1234".
//
// Idempotent: re-running deletes each persona org and everything hanging off
// it, then recreates it — so the suite always lands in exactly this state.
// Pass --drop to remove the personas without recreating them.
//
// Safety: same two guards as seed-brandhub-demo.js — connects only via
// MONGODB_URI_TEST, and additionally refuses any database whose name does not
// look like a test database.
//
// SCHEMA LIMITS — two things the persona briefs ask for cannot be stored,
// because lib/models.ts has nowhere to put them. They are approximated here
// and called out so nobody reads the seeded data as proof the feature works:
//
//   * Water metrics. There is no water field anywhere in the schema; only
//     waste weight and CO2. Diego's water figures are not seeded.
//   * Deal types (coupon / tiered / BOGO) and campaign/deal "draft" status.
//     DealSchema has no `type` field, and the status enums are
//     PENDING|APPROVED|REJECTED|EXPIRED (campaigns) and
//     pending|active|rejected|inactive|expired (deals) — no draft in either.
//     Deal shape is encoded in the title/description and the
//     discount/minimumPurchase fields instead.
//
// Mongoose silently strips unknown fields, so inventing `type` or `water`
// keys here would look like it worked and persist nothing. Hence the
// explicit approximation.
//
// Environmental data is seeded as DATED BUCKETS (environmentalPeriods), which
// is what makes the ESG statistics period actually scope tonnage. Sol
// Beverages is the deliberate exception, left on the legacy cumulative
// snapshot so the route's fallback and the client's "All-time" badge stay
// covered by the suite.

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI_TEST;

if (!MONGODB_URI) {
  throw new Error(
    "MONGODB_URI_TEST is not set — refusing to seed the primary database. " +
      "Define MONGODB_URI_TEST in .env (a separate test database).",
  );
}

const PASSWORD = "test1234";
const ALL_MODULES = ["consumer-reporting", "esg", "minttrace"];
const DAY = 24 * 60 * 60 * 1000;

// Every org this script owns. Used for the idempotent reset, so renaming an
// org here means the old one must be dropped manually.
const PERSONA_ORG_NAMES = [
  "Verdant Cosmetics",
  "La Terra Foods Group",
  "NewBrand Sustainables",
  "Cielo Apparel",
  "Ozone Beverages",
];

const PERSONA_EMAILS = [
  "aisha@verdant.co",
  "marcus@laterrafoods.com",
  "priya@newbrand.io",
  "diego@cieloapparel.com",
  "yuki@ozonebev.jp",
];

function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// Local-calendar day string. Deliberately NOT dateOnly(): toISOString()
// converts to UTC first, so in any timezone ahead of UTC the first of a month
// serialises as the last day of the previous one. Month-bucket bounds have to
// be exact or the aggregation window is off by a day at both ends.
function localDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// `count` consecutive whole-month impact buckets ending with the current
// month. Each month scales `shape` by a deterministic factor so the series has
// realistic variation without being random (a re-run must reproduce it
// exactly). totalWasteKg is DERIVED from the breakdown rather than stated
// independently, so the two can never drift apart.
function monthlyPeriods(count, shape, co2PerKg = 1.5) {
  const periods = [];
  for (let i = count - 1; i >= 0; i--) {
    const anchor = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    // Day 0 of the next month is the last day of this one.
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const factor = 0.75 + ((count - i) % 5) * 0.125;
    const materialBreakdown = shape.map((m) => ({
      material: m.material,
      weightKg: Math.round(m.weightKg * factor),
    }));
    const totalWasteKg = materialBreakdown.reduce((s, m) => s + m.weightKg, 0);
    periods.push({
      periodStart: localDay(start),
      periodEnd: localDay(end),
      totalWasteKg,
      co2AvoidedKg: Math.round(totalWasteKg * co2PerKg),
      materialBreakdown,
    });
  }
  return periods;
}

const now = new Date();
const offsetDay = (days) => dateOnly(new Date(now.getTime() + days * DAY));

async function main() {
  const dropOnly = process.argv.includes("--drop");

  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  // Belt-and-braces on top of the MONGODB_URI_TEST-only connection above:
  // the database name itself must clearly be a test database.
  const dbName = mongoose.connection.db.databaseName;
  if (!/(^|[-_])test([-_]|$)|^test_db$/i.test(dbName)) {
    await mongoose.disconnect();
    throw new Error(
      `Refusing to seed: connected database is "${dbName}", which does not ` +
        "look like a test database. This script only runs against the " +
        "isolated test database.",
    );
  }

  const organizations = mongoose.connection.collection("organizations");
  const brandusers = mongoose.connection.collection("brandusers");
  const brands = mongoose.connection.collection("brands");
  const campaigns = mongoose.connection.collection("campaigns");
  const deals = mongoose.connection.collection("deals");

  // ---- Reset -------------------------------------------------------------
  // Brands are matched by orgId AND by the persona brand names, so a brand
  // orphaned by a previous half-failed run is still cleaned up.
  const priorOrgs = await organizations
    .find({ name: { $in: PERSONA_ORG_NAMES } })
    .toArray();
  const priorOrgIds = priorOrgs.map((o) => o._id);
  const priorBrands = await brands
    .find({ orgId: { $in: priorOrgIds } })
    .toArray();
  const priorBrandIds = priorBrands.map((b) => b._id);

  await campaigns.deleteMany({ brand: { $in: priorBrandIds } });
  await deals.deleteMany({ brand: { $in: priorBrandIds } });
  await brands.deleteMany({ _id: { $in: priorBrandIds } });
  await brandusers.deleteMany({ email: { $in: PERSONA_EMAILS } });
  await organizations.deleteMany({ _id: { $in: priorOrgIds } });

  if (dropOnly) {
    console.log(
      `🧹 Dropped ${priorOrgIds.length} persona org(s), ` +
        `${priorBrandIds.length} brand(s) and their campaigns/deals from "${dbName}".`,
    );
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // ---- Helpers -----------------------------------------------------------

  async function createOrg(name, plan, modules = ALL_MODULES) {
    const { insertedId } = await organizations.insertOne({
      name,
      plan,
      moduleSubscriptions: modules.map((module) => ({
        module,
        status: "active",
        activatedAt: new Date(now.getTime() - 120 * DAY),
        expiresAt: null,
      })),
      createdAt: now,
      updatedAt: now,
    });
    return insertedId;
  }

  async function createUser(orgId, email, orgRole = "owner") {
    await brandusers.insertOne({
      orgId,
      email,
      passwordHash,
      orgRole,
      // owner/admin get implicit full access; moduleAccess only matters for
      // members (see getModulePermission in the BrandHub client).
      moduleAccess: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  // `overrides.status` defaults to APPROVED so personas land on a usable
  // dashboard — a PENDING brand renders the pending-approval screen instead
  // of any tab, which is Priya's scenario specifically and nobody else's.
  async function createBrand(orgId, overrides = {}) {
    const brandId = new mongoose.Types.ObjectId();
    // `email` is deliberately required with no fallback. The obvious default
    // — `brand-<id>@brandhub.local`, copied from seed-brandhub-demo.js — is a
    // LEGACY shape the current register route never produces (it stores the
    // registrant's real address). Worse, pairing that placeholder with a
    // human contactName produces a combination no real brand can have:
    // resolveBrandEmail() only falls back to contactName when it contains
    // "@", so the raw brand-...@brandhub.local string leaks into the
    // Settings "Contact Email" field. Pass a real, unique address.
    if (!overrides.email) {
      throw new Error(`createBrand: email is required for "${overrides.brandName}"`);
    }
    const doc = {
      _id: brandId,
      orgId,
      brandName: overrides.brandName,
      companyName: overrides.companyName ?? overrides.brandName,
      email: overrides.email,
      category: overrides.category ?? "general",
      description: overrides.description ?? "",
      address: overrides.address ?? "",
      webLink: overrides.webLink ?? "https://example.com",
      appLink: overrides.appLink ?? "",
      contactName: overrides.contactName ?? "",
      phone: overrides.phone ?? "N/A",
      registrationNumber: `BH-${brandId.toString()}`,
      domain: overrides.domain ?? "",
      themeColor: overrides.themeColor ?? "#3B82F6",
      status: overrides.status ?? "APPROVED",
      role: "BRAND",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    };
    // A brand carries dated buckets OR the legacy cumulative snapshot, never
    // both — the analytics route prefers buckets, so seeding both would leave
    // the snapshot silently unreachable and untested.
    if (overrides.environmentalPeriods) {
      doc.environmentalPeriods = overrides.environmentalPeriods;
    } else if (overrides.environmentalStats) {
      doc.environmentalStats = overrides.environmentalStats;
    }
    await brands.insertOne(doc);
    return brandId;
  }

  // Redemptions drive the analytics summary: totalRedemptions counts entries
  // across campaigns, uniqueUsers de-duplicates them — so reusing ids from a
  // per-brand pool keeps uniqueUsers < totalRedemptions, as in real data.
  const pool = (n) =>
    Array.from({ length: n }, () => new mongoose.Types.ObjectId());

  const campaignDoc = (brandId, name, status, startOff, endOff, users, extra = {}) => ({
    name,
    brand: brandId,
    brandRegistration: `BH-${brandId.toString()}`,
    status,
    startDate: offsetDay(startOff),
    endDate: offsetDay(endOff),
    users,
    discountCodes: [],
    isSingleCode: false,
    addresses: [],
    description: `${name} — seeded QA campaign`,
    backgroundColor: "#0F172A",
    budget: 5000,
    campaignType: "general",
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

  const dealDoc = (brandId, title, status, extra = {}) => ({
    brand: brandId,
    title,
    description: `${title} — seeded QA deal`,
    discountPercentage: null,
    discountAmount: null,
    codes: [],
    promoCode: null,
    startDate: null,
    endDate: null,
    maxUses: null,
    currentUses: 0,
    minimumPurchase: null,
    status,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

  const summary = [];

  // ---- 1. Aisha Karim — solo brand owner ---------------------------------
  // 8 campaigns, 12 deals in mixed states, plus a cumulative impact snapshot.
  {
    const orgId = await createOrg("Verdant Cosmetics", "growth");
    await createUser(orgId, "aisha@verdant.co");
    const brandId = await createBrand(orgId, {
      brandName: "Verdant Cosmetics",
      companyName: "Verdant Cosmetics Ltd",
      email: "aisha@verdant.co",
      category: "Beauty & Personal Care",
      description: "Refillable skincare with a returns-for-rewards programme.",
      address: "14 Harbour Road, Dubai",
      webLink: "https://verdant.co",
      contactName: "Aisha Karim",
      phone: "+971501234567",
      themeColor: "#2F855A",
      // 6 months of dated buckets, per the persona brief.
      environmentalPeriods: monthlyPeriods(6, [
        { material: "Glass", weightKg: 240 },
        { material: "Plastic", weightKg: 165 },
        { material: "Aluminum", weightKg: 105 },
        { material: "Paper", weightKg: 70 },
      ]),
    });

    const u = pool(9);
    await campaigns.insertMany([
      campaignDoc(brandId, "Refill & Reward", "APPROVED", -45, 25, [u[0], u[1], u[2], u[3], u[4]], {
        campaignType: "loyalty",
        badge: "POPULAR",
        subtitle: "Bring back 3 empties, get one free",
      }),
      campaignDoc(brandId, "Spring Glow Bundle", "APPROVED", -12, 18, [u[0], u[5], u[6]], {
        campaignType: "seasonal",
      }),
      campaignDoc(brandId, "Founders Week", "APPROVED", -120, -95, [u[1], u[2], u[7]], {
        campaignType: "brandAwareness",
      }),
      campaignDoc(brandId, "Botanical Launch", "APPROVED", -75, -50, [u[3], u[8]], {
        campaignType: "productLaunch",
      }),
      campaignDoc(brandId, "Summer Serum Drop", "PENDING", 10, 40, []),
      campaignDoc(brandId, "Influencer Collab Q3", "PENDING", 20, 60, [], {
        campaignType: "influencer",
      }),
      campaignDoc(brandId, "Discount Stack Test", "REJECTED", -30, 10, []),
      // Explicitly EXPIRED, distinct from "APPROVED with a past end date" —
      // the frontend derives one and the backend stores the other.
      campaignDoc(brandId, "Winter Repair Ritual", "EXPIRED", -200, -160, [u[4], u[5]], {
        campaignType: "seasonal",
      }),
    ]);

    const activeDeal = (title, pct, extra = {}) =>
      dealDoc(brandId, title, "active", {
        discountPercentage: pct,
        startDate: offsetDay(-20),
        endDate: offsetDay(30),
        minimumPurchase: 100,
        ...extra,
      });

    await deals.insertMany([
      activeDeal("15% Off Cleansers", 15, { codes: ["VERD15"], promoCode: "VERD15" }),
      activeDeal("20% Off Serums", 20, { codes: ["SERUM20"], promoCode: "SERUM20" }),
      activeDeal("10% Off First Order", 10, { codes: ["WELCOME10"], promoCode: "WELCOME10" }),
      activeDeal("Refill Bundle Saver", 25, { maxUses: 500, currentUses: 138 }),
      dealDoc(brandId, "Black Friday Doorbuster", "expired", {
        discountPercentage: 40,
        startDate: offsetDay(-150),
        endDate: offsetDay(-140),
        currentUses: 412,
      }),
      dealDoc(brandId, "New Year Reset", "expired", {
        discountPercentage: 30,
        startDate: offsetDay(-120),
        endDate: offsetDay(-100),
        currentUses: 260,
      }),
      dealDoc(brandId, "Sample Sachet Giveaway", "expired", {
        discountPercentage: 100,
        startDate: offsetDay(-90),
        endDate: offsetDay(-80),
        maxUses: 200,
        currentUses: 200,
      }),
      // "draft" is not in the deal enum — `inactive` is the closest thing the
      // schema can express (renders as Paused in the lifecycle bucketing).
      dealDoc(brandId, "Autumn Concept (unpublished)", "inactive", {
        discountPercentage: 15,
      }),
      dealDoc(brandId, "Gift Set Idea (unpublished)", "inactive", {
        discountPercentage: 20,
      }),
      dealDoc(brandId, "Loyalty Tier Draft", "inactive", { discountPercentage: 5 }),
      dealDoc(brandId, "Bundle Pricing Proposal", "pending", {
        discountPercentage: 35,
        startDate: offsetDay(5),
        endDate: offsetDay(35),
      }),
      dealDoc(brandId, "Competitor Match Offer", "rejected", {
        discountPercentage: 50,
      }),
    ]);

    summary.push(["Aisha Karim", "aisha@verdant.co", brandId, "8 campaigns, 12 deals, impact snapshot"]);
  }

  // ---- 2. Marcus Chen — multi-brand marketing lead ------------------------
  // 4 brands: 2 populated, 1 sparse, 1 empty. Exercises the brand picker,
  // the brandSession cache, and per-brand scoping.
  {
    const orgId = await createOrg("La Terra Foods Group", "enterprise");
    await createUser(orgId, "marcus@laterrafoods.com");

    const common = {
      companyName: "La Terra Foods Group",
      category: "Food & Beverage",
      contactName: "Marcus Chen",
      phone: "+14155550132",
      address: "88 Mission Street, San Francisco",
    };

    // Populated #1
    const verde = await createBrand(orgId, {
      ...common,
      brandName: "Verde Snacks",
      // Brand.email is unique, so each brand in this org needs its own
      // address — a multi-brand group cannot reuse the owner's login email.
      email: "hello@verdesnacks.com",
      webLink: "https://verdesnacks.com",
      themeColor: "#4D7C0F",
      environmentalPeriods: monthlyPeriods(4, [
        { material: "Plastic", weightKg: 300 },
        { material: "Paper", weightKg: 225 },
      ]),
    });
    const vu = pool(6);
    await campaigns.insertMany([
      campaignDoc(verde, "Snack Smarter", "APPROVED", -30, 30, [vu[0], vu[1], vu[2]]),
      campaignDoc(verde, "Trail Mix Tuesdays", "APPROVED", -60, -20, [vu[1], vu[3]]),
      campaignDoc(verde, "Back To School Packs", "PENDING", 14, 44, []),
    ]);
    await deals.insertMany([
      dealDoc(verde, "2 for 1 Snack Packs", "active", {
        discountPercentage: 50,
        startDate: offsetDay(-10),
        endDate: offsetDay(20),
        codes: ["VERDE2FOR1"],
        promoCode: "VERDE2FOR1",
      }),
      dealDoc(verde, "Bulk Box 20% Off", "active", {
        discountPercentage: 20,
        startDate: offsetDay(-5),
        endDate: offsetDay(45),
      }),
      dealDoc(verde, "Summer Clearance", "expired", {
        discountPercentage: 35,
        startDate: offsetDay(-100),
        endDate: offsetDay(-70),
      }),
    ]);

    // Populated #2
    const sol = await createBrand(orgId, {
      ...common,
      brandName: "Sol Beverages",
      email: "hello@solbeverages.com",
      webLink: "https://solbeverages.com",
      themeColor: "#EA580C",
      // Deliberately left on the LEGACY cumulative snapshot — the one brand in
      // the suite that exercises the analytics route's fallback path and the
      // client's "All-time" badge. Do not convert this to buckets.
      environmentalStats: {
        totalWasteKg: 4800,
        co2AvoidedKg: 7200,
        materialBreakdown: [
          { material: "Aluminum", weightKg: 3100 },
          { material: "Glass", weightKg: 1700 },
        ],
      },
    });
    const su = pool(7);
    await campaigns.insertMany([
      campaignDoc(sol, "Can Return Rewards", "APPROVED", -50, 40, [su[0], su[1], su[2], su[3]]),
      campaignDoc(sol, "Citrus Season", "APPROVED", -15, 15, [su[0], su[4]]),
      campaignDoc(sol, "Festival Pop-Up", "REJECTED", -10, 20, []),
    ]);
    await deals.insertMany([
      dealDoc(sol, "Buy 6 Cans Get 2", "active", {
        discountPercentage: 25,
        startDate: offsetDay(-8),
        endDate: offsetDay(25),
        codes: ["SOL6GET2"],
        promoCode: "SOL6GET2",
      }),
      dealDoc(sol, "Glass Bottle Deposit Back", "active", {
        discountAmount: 50,
        startDate: offsetDay(-30),
        endDate: offsetDay(60),
      }),
    ]);

    // Sparse — one pending campaign, nothing else.
    const raiz = await createBrand(orgId, {
      ...common,
      brandName: "Raíz Grains",
      email: "hello@raizgrains.com",
      webLink: "https://raizgrains.com",
      themeColor: "#A16207",
    });
    await campaigns.insertOne(
      campaignDoc(raiz, "Heritage Grain Launch", "PENDING", 7, 37, []),
    );

    // Empty — no campaigns, no deals, no stats. First-run states on a brand
    // that is nonetheless APPROVED, which Priya's PENDING brand cannot show.
    const puro = await createBrand(orgId, {
      ...common,
      brandName: "Puro Water",
      email: "hello@purowater.com",
      webLink: "https://purowater.com",
      themeColor: "#0EA5E9",
    });

    summary.push([
      "Marcus Chen",
      "marcus@laterrafoods.com",
      `${verde} (populated), ${sol} (populated), ${raiz} (sparse), ${puro} (empty)`,
      "4 brands",
    ]);
  }

  // ---- 3. Priya Sharma — fresh registrant ---------------------------------
  // Mirrors app/api/brandhub/auth/register/route.ts byte for byte: the same
  // placeholder fallbacks (webLink "https://example.com", contactName = the
  // email, phone "N/A", category "general") and the same PENDING status.
  // Do not "tidy" these values — reproducing the placeholder scaffolding is
  // the entire point of this persona.
  {
    const orgId = await createOrg("NewBrand Sustainables", "starter");
    await createUser(orgId, "priya@newbrand.io");
    const brandId = await createBrand(orgId, {
      brandName: "NewBrand Sustainables",
      companyName: "NewBrand Sustainables",
      // Register stores the registrant's real address here and ALSO copies it
      // into contactName (the `contactName ?? normalizedEmail` fallback) —
      // verified against a live registration. Both are intentional.
      email: "priya@newbrand.io",
      category: "general",
      contactName: "priya@newbrand.io",
      phone: "N/A",
      webLink: "https://example.com",
      themeColor: "#3B82F6",
      status: "PENDING",
      emailVerified: false,
    });
    // Deliberately no campaigns, deals, or environmentalStats.
    summary.push([
      "Priya Sharma",
      "priya@newbrand.io",
      brandId,
      "PENDING brand, placeholder scaffolding, no data",
    ]);
  }

  // ---- 4. Diego Fernández — analytics operator ----------------------------
  // Rich impact data, minimal promotions. Water metrics are omitted: the
  // schema has no field for them (see SCHEMA LIMITS).
  {
    const orgId = await createOrg("Cielo Apparel", "growth");
    await createUser(orgId, "diego@cieloapparel.com");
    const brandId = await createBrand(orgId, {
      brandName: "Cielo Apparel",
      companyName: "Cielo Apparel SA",
      email: "diego@cieloapparel.com",
      category: "Fashion & Apparel",
      description: "Circular textile programme — garments back, fibres forward.",
      address: "Gran Vía 42, Madrid",
      webLink: "https://cieloapparel.com",
      contactName: "Diego Fernández",
      phone: "+34600123456",
      themeColor: "#7C3AED",
      // The full 12-month series the brief asks for — Diego is the persona
      // for stressing the statistics period, so he gets the deepest history.
      environmentalPeriods: monthlyPeriods(12, [
        { material: "Cotton", weightKg: 600 },
        { material: "Polyester", weightKg: 425 },
        { material: "Denim", weightKg: 275 },
        { material: "Wool", weightKg: 155 },
        { material: "Mixed Fibre", weightKg: 100 },
      ]),
    });

    const du = pool(4);
    await campaigns.insertMany([
      campaignDoc(brandId, "Take-Back Tuesdays", "APPROVED", -180, 60, [du[0], du[1], du[2]], {
        campaignType: "loyalty",
      }),
      campaignDoc(brandId, "Denim Recycling Drive", "APPROVED", -90, -30, [du[1], du[3]]),
    ]);
    await deals.insertOne(
      dealDoc(brandId, "€10 Off When You Return a Garment", "active", {
        discountAmount: 10,
        startDate: offsetDay(-60),
        endDate: offsetDay(90),
        minimumPurchase: 40,
      }),
    );

    summary.push([
      "Diego Fernández",
      "diego@cieloapparel.com",
      brandId,
      "18.6t waste / 28t CO2, 5 materials, 2 campaigns, 1 deal",
    ]);
  }

  // ---- 5. Yuki Tanaka — promotions power user -----------------------------
  // 15 campaigns (5 live / 5 scheduled / 5 ended) and 20 deals. The volume is
  // the point: this is the persona most likely to surface pagination and
  // filtering gaps in the Promotions tab.
  {
    const orgId = await createOrg("Ozone Beverages", "enterprise");
    await createUser(orgId, "yuki@ozonebev.jp");
    const brandId = await createBrand(orgId, {
      brandName: "Ozone Beverages",
      companyName: "Ozone Beverages KK",
      email: "yuki@ozonebev.jp",
      category: "Food & Beverage",
      description: "Sparkling water in returnable glass.",
      address: "2-1 Shibuya, Tokyo",
      webLink: "https://ozonebev.jp",
      contactName: "Yuki Tanaka",
      phone: "+81312345678",
      themeColor: "#0891B2",
      environmentalPeriods: monthlyPeriods(8, [
        { material: "Glass", weightKg: 640 },
        { material: "Aluminum", weightKg: 215 },
        { material: "Plastic", weightKg: 115 },
      ]),
    });

    const yu = pool(12);
    const yCampaigns = [];

    // Live: started in the past, ends in the future. All APPROVED, since
    // lifecycleOf only reports "live" for an approved record inside its window.
    for (let i = 0; i < 5; i++) {
      yCampaigns.push(
        campaignDoc(brandId, `Sparkling Summer Vol.${i + 1}`, "APPROVED", -20 - i * 5, 20 + i * 5,
          yu.slice(0, 3 + i), { campaignType: "seasonal" }),
      );
    }
    // Scheduled: APPROVED but the window has not opened yet.
    for (let i = 0; i < 5; i++) {
      yCampaigns.push(
        campaignDoc(brandId, `Autumn Yuzu Drop ${i + 1}`, "APPROVED", 10 + i * 7, 40 + i * 7, [], {
          campaignType: "productLaunch",
        }),
      );
    }
    // Ended: window closed. Left APPROVED so the frontend's derived-expiry
    // path (hasExpired) is exercised rather than a stored EXPIRED status.
    for (let i = 0; i < 5; i++) {
      yCampaigns.push(
        campaignDoc(brandId, `Winter Citrus ${i + 1}`, "APPROVED", -150 - i * 10, -120 - i * 10,
          yu.slice(i, i + 4), { campaignType: "seasonal" }),
      );
    }
    await campaigns.insertMany(yCampaigns);

    // 20 deals. `type` has no schema field, so the shape is expressed through
    // the discount fields and named in the title — see SCHEMA LIMITS.
    const yDeals = [];
    for (let i = 0; i < 7; i++) {
      yDeals.push(
        dealDoc(brandId, `Coupon — ${10 + i * 5}% Off Multipack`, i < 5 ? "active" : "inactive", {
          discountPercentage: 10 + i * 5,
          startDate: offsetDay(-15),
          endDate: offsetDay(45),
          codes: [`OZONE${10 + i * 5}`],
          promoCode: `OZONE${10 + i * 5}`,
          maxUses: 1000,
          currentUses: 120 + i * 37,
        }),
      );
    }
    for (let i = 0; i < 7; i++) {
      yDeals.push(
        dealDoc(brandId, `Tiered — Spend ¥${(i + 2) * 1000}, Save ¥${(i + 1) * 200}`,
          i < 4 ? "active" : "expired", {
            discountAmount: (i + 1) * 200,
            minimumPurchase: (i + 2) * 1000,
            startDate: offsetDay(i < 4 ? -10 : -120),
            endDate: offsetDay(i < 4 ? 30 : -90),
          }),
      );
    }
    for (let i = 0; i < 6; i++) {
      yDeals.push(
        dealDoc(brandId, `BOGO — Buy ${i + 1} Get 1 Free`,
          ["active", "pending", "rejected", "inactive", "expired", "active"][i], {
            discountPercentage: 50,
            minimumPurchase: (i + 1) * 500,
            startDate: offsetDay(-5),
            endDate: offsetDay(40),
          }),
      );
    }
    await deals.insertMany(yDeals);

    summary.push([
      "Yuki Tanaka",
      "yuki@ozonebev.jp",
      brandId,
      "15 campaigns (5 live / 5 scheduled / 5 ended), 20 deals",
    ]);
  }

  // ---- Report ------------------------------------------------------------
  console.log(`\n✅ Seeded 5 QA personas into "${dbName}". Password: ${PASSWORD}\n`);
  for (const [name, email, brandId, note] of summary) {
    console.log(`  ${name}`);
    console.log(`    login : ${email} / ${PASSWORD}`);
    console.log(`    brand : ${brandId}`);
    console.log(`    data  : ${note}\n`);
  }
  console.log("  Re-run to reset. Run with --drop to remove without recreating.\n");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("❌ Persona seed failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
