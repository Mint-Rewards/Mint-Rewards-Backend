#!/usr/bin/env node
/**
 * MintRewards API test runner
 * Usage: node scripts/test-api.mjs [--local]
 *
 * --local  targets http://localhost:3000/api instead of the deployed branch URL
 */

const USE_LOCAL = process.argv.includes("--local");

const BASE = USE_LOCAL
  ? "http://localhost:3000/api"
  : "https://mint-rewards-backend-git-feature-b-78cea7-mint-rewards-projects.vercel.app/api";

// Admin credentials for POST /api/admin/login (from .env.local for local, or
// Vercel dashboard env for deployed):
//   ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> node scripts/test-api.mjs
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Error: ADMIN_EMAIL and ADMIN_PASSWORD env vars are required.");
  process.exit(1);
}

// ─── Shared state populated during the run ───────────────────────────────────
let ADMIN_TOKEN = "";
// BRAND_ID: legacy /brands/register brand (no orgId) — used for
// registration/retrieval/admin-approval tests only.
let BRAND_ID = "";
// BRAND_TOKEN / HUB_BRAND_ID: a brandhub org + brand user + brand (has
// orgId) — required for the now brand-auth-gated settings/campaigns/deals/
// analytics routes, since requireBrandScope rejects orgId-less brands.
let BRAND_TOKEN = "";
let HUB_BRAND_ID = "";
let CAMPAIGN_ID = "";
let DEAL_ID = "";
let registeredRegNumber = "";

// USER_*: a MintRewards *app* user (id-based JWT via /users/signup), required
// for the getAuthenticatedUserId-gated routes (my-profile, my-discounts,
// referrals, active-campaigns, coupons/redeem, update-profile).
let USER_TOKEN = "";
let USER_ID = "";
let USER_EMAIL = "";
let USER_PASSWORD = "";
// A newly created brandhub brand id (from POST /brandhub/brands) — kept
// separate from HUB_BRAND_ID so brand-creation tests don't disturb the
// brand the campaign/deal suites rely on.
let NEW_HUB_BRAND_ID = "";

// ─── Minimal 1×1 white PNG (no external files needed for upload tests) ───────
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

let passed = 0;
let failed = 0;
let skipped = 0;

function section(title) {
  console.log(`\n${BOLD}${CYAN}── ${title} ${"─".repeat(Math.max(0, 50 - title.length))}${RESET}`);
}

function log(label, status, detail = "") {
  const icon   = status === "PASS" ? `${GREEN}✓` : status === "SKIP" ? `${YELLOW}⊘` : `${RED}✗`;
  const colour = status === "PASS" ? GREEN : status === "SKIP" ? YELLOW : RED;
  console.log(`  ${icon} ${colour}${label}${RESET}${detail ? `  ${DIM}${detail}${RESET}` : ""}`);
  if (status === "PASS")  passed++;
  else if (status === "FAIL") failed++;
  else skipped++;
}

async function call(method, path, { body, headers = {}, form } = {}) {
  const url = `${BASE}${path}`;
  const opts = { method, headers };

  if (form) {
    opts.body = form;
    // Do NOT set Content-Type — the browser/fetch adds the boundary automatically
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

function adminHeaders() {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

function brandHeaders() {
  return { Authorization: `Bearer ${BRAND_TOKEN}` };
}

// The /users/signup + social routes return the token already prefixed with
// "Bearer " (e.g. "Bearer eyJ..."), so USER_TOKEN is the full header value.
function userHeaders() {
  return { Authorization: USER_TOKEN };
}

// ─── Auth setup ──────────────────────────────────────────────────────────────

async function authenticateAdmin() {
  section("Auth  POST /admin/login");
  const { status, data } = await call("POST", "/admin/login", {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (status === 200 && data.token) {
    ADMIN_TOKEN = data.token;
    log("Admin login", "PASS");
  } else {
    log("Admin login", "FAIL", `status=${status} msg="${data.error}"`);
    console.error("Cannot continue without an admin token — aborting.");
    process.exit(1);
  }
}

// Registers a fresh org + brand user + brand via brandhub so the brand has an
// orgId set (legacy /brands/register brands have none and can never pass
// requireBrandScope — they'd need to be adopted into an org first).
async function registerBrandUser() {
  section("Auth  POST /brandhub/auth/register");
  const unique = Date.now();
  const { status, data } = await call("POST", "/brandhub/auth/register", {
    body: {
      orgName: `Test Org ${unique}`,
      email: `brandowner${unique}@testbrand.com`,
      password: "TestPassword123!",
      brandName: `BrandHub Brand ${unique}`,
    },
  });
  if (status === 201 && data.token && data.defaultBrandId) {
    BRAND_TOKEN = data.token;
    HUB_BRAND_ID = data.defaultBrandId;
    log("Brand user registration", "PASS", `brandId=${HUB_BRAND_ID}`);
  } else {
    log("Brand user registration", "FAIL", `status=${status} msg="${data.error}"`);
    console.error("Cannot continue without a brand token — aborting.");
    process.exit(1);
  }
}

// ─── Test groups ─────────────────────────────────────────────────────────────

async function testRegistration() {
  section("Brand Registration  POST /brands/register");

  // 1. Missing required fields
  {
    const fd = new FormData();
    fd.append("brandName", "Incomplete Brand");
    const { status, data } = await call("POST", "/brands/register", { form: fd });
    if (status === 400 && Array.isArray(data.fields)) {
      log("Rejects missing required fields", "PASS", `fields: ${data.fields.join(", ")}`);
    } else {
      log("Rejects missing required fields", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // 2. Successful registration (logo as tiny PNG)
  {
    const unique = Date.now();
    const fd = new FormData();
    fd.append("companyName", `Test Company ${unique}`);
    fd.append("brandName",   `TestBrand ${unique}`);
    fd.append("category",    "Retail");
    fd.append("website",     "https://testbrand.com");
    fd.append("contactName", "Jane Doe");
    fd.append("contactPhone","+27 82 000 1234");
    fd.append("contactEmail",`jane${unique}@testbrand.com`);
    fd.append("registrationNumber", `REG-${unique}`);
    fd.append("appLink",     "https://apps.apple.com/testbrand");
    fd.append("address",     "1 Green Street, Cape Town");
    fd.append("description", "We are an eco-friendly retail brand.");
    fd.append("themeColor",  "#22C55E");
    fd.append("domain",      "testbrand.com");
    fd.append("logo",        new Blob([TINY_PNG], { type: "image/png" }), "logo.png");

    const { status, data } = await call("POST", "/brands/register", { form: fd });
    if (status === 201 && data.success && data.brandId) {
      BRAND_ID = String(data.brandId);
      registeredRegNumber = `REG-${unique}`;
      log("Registers brand (with logo)", "PASS", `brandId=${BRAND_ID}`);
    } else {
      log("Registers brand (with logo)", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // 3. Duplicate registration number (reuse the exact reg number from successful registration)
  if (BRAND_ID && registeredRegNumber) {
    const fd = new FormData();
    fd.append("companyName",       "Dupe Company");
    fd.append("brandName",         "DupeBrand");
    fd.append("category",          "Retail");
    fd.append("website",           "https://dupe.com");
    fd.append("contactName",       "John Dup");
    fd.append("contactPhone",      "+27 82 000 0000");
    fd.append("contactEmail",      `dupe${Date.now()}@dupe.com`);
    fd.append("registrationNumber", registeredRegNumber); // exact duplicate
    const { status, data } = await call("POST", "/brands/register", { form: fd });
    if (status === 409) {
      log("Duplicate reg number returns 409", "PASS", data.message);
    } else {
      log("Duplicate reg number returns 409", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // 4. Non-image logo rejected
  {
    const fd = new FormData();
    fd.append("companyName",       "BadLogo Co");
    fd.append("brandName",         "BadLogo");
    fd.append("category",          "Tech");
    fd.append("website",           "https://badlogo.com");
    fd.append("contactName",       "Alice");
    fd.append("contactPhone",      "+27 21 000 0000");
    fd.append("contactEmail",      `badlogo${Date.now()}@test.com`);
    fd.append("registrationNumber",`REG-BADLOGO-${Date.now()}`);
    fd.append("logo", new Blob(["not-an-image"], { type: "text/plain" }), "bad.txt");
    const { status, data } = await call("POST", "/brands/register", { form: fd });
    if (status === 400 && data.message?.toLowerCase().includes("image")) {
      log("Rejects non-image logo", "PASS", data.message);
    } else {
      log("Rejects non-image logo", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }
}

async function testBrandRetrieval() {
  section("Brand Retrieval");

  // GET /brands (pending list) — no auth → 401
  {
    const { status } = await call("GET", "/brands");
    if (status === 401) {
      log("GET /brands without auth → 401", "PASS");
    } else {
      log("GET /brands without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // GET /brands (pending list, admin)
  {
    const { status, data } = await call("GET", "/brands", { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.brands)) {
      log("GET /brands — pending list", "PASS", `count=${data.brands.length}`);
    } else {
      log("GET /brands — pending list", "FAIL", `status=${status}`);
    }
  }

  // GET /brands/fetch (legacy pending list) — no auth → 401
  {
    const { status } = await call("GET", "/brands/fetch");
    if (status === 401) {
      log("GET /brands/fetch without auth → 401", "PASS");
    } else {
      log("GET /brands/fetch without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // GET /brands/fetch (legacy pending list, admin)
  {
    const { status, data } = await call("GET", "/brands/fetch", { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.brands)) {
      log("GET /brands/fetch — legacy pending list", "PASS", `count=${data.brands.length}`);
    } else {
      log("GET /brands/fetch — legacy pending list", "FAIL", `status=${status}`);
    }
  }

  // GET /brands/:id
  if (BRAND_ID) {
    const { status, data } = await call("GET", `/brands/${BRAND_ID}`);
    if (status === 200 && data.brand) {
      log("GET /brands/:id", "PASS", `name="${data.brand.brandName}"`);
    } else {
      log("GET /brands/:id", "FAIL", `status=${status}`);
    }
  } else {
    log("GET /brands/:id", "SKIP", "no BRAND_ID");
  }

  // GET /brands/:id — invalid ID
  {
    const { status } = await call("GET", "/brands/000000000000000000000000");
    if (status === 404) {
      log("GET /brands/:id — 404 on bad ID", "PASS");
    } else {
      log("GET /brands/:id — 404 on bad ID", "FAIL", `status=${status}`);
    }
  }
}

async function testBrandAdmin() {
  section("Brand Admin  PATCH /brands/:id");

  if (!BRAND_ID) {
    log("All admin tests", "SKIP", "no BRAND_ID from registration");
    return;
  }

  // Approve without auth → 401
  {
    const { status } = await call("PATCH", `/brands/${BRAND_ID}`, {
      body: { status: "APPROVED" },
    });
    if (status === 401) {
      log("Approve without auth → 401", "PASS");
    } else {
      log("Approve without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // Invalid status value → 400
  {
    const { status, data } = await call("PATCH", `/brands/${BRAND_ID}`, {
      body: { status: "ACTIVE" },
      headers: adminHeaders(),
    });
    if (status === 400) {
      log("Invalid status value → 400", "PASS", data.error);
    } else {
      log("Invalid status value → 400", "FAIL", `status=${status}`);
    }
  }

  // Approve brand
  {
    const { status, data } = await call("PATCH", `/brands/${BRAND_ID}`, {
      body: { status: "APPROVED" },
      headers: adminHeaders(),
    });
    if (status === 200 && data.brand?.status === "APPROVED") {
      log("Approve brand", "PASS");
    } else {
      log("Approve brand", "FAIL", `status=${status} brandStatus=${data.brand?.status}`);
    }
  }

  // Reject brand with reason
  {
    const { status, data } = await call("PATCH", `/brands/${BRAND_ID}`, {
      body: { status: "REJECTED", reason: "Incomplete documentation." },
      headers: adminHeaders(),
    });
    if (status === 200 && data.brand?.status === "REJECTED") {
      log("Reject brand with reason", "PASS");
    } else {
      log("Reject brand with reason", "FAIL", `status=${status}`);
    }
  }

  // Re-approve (needed for subsequent tests)
  {
    const { status, data } = await call("PATCH", `/brands/${BRAND_ID}`, {
      body: { status: "APPROVED" },
      headers: adminHeaders(),
    });
    if (status === 200) {
      log("Re-approve brand for subsequent tests", "PASS");
    } else {
      log("Re-approve brand for subsequent tests", "FAIL", `status=${status} msg="${data.error}"`);
    }
  }
}

async function testBrandSettings() {
  section("Brand Settings  PATCH /brands/:id/settings");

  if (!HUB_BRAND_ID) {
    log("All settings tests", "SKIP", "no HUB_BRAND_ID");
    return;
  }

  // No auth → 401
  {
    const { status } = await call("PATCH", `/brands/${HUB_BRAND_ID}/settings`, {
      body: { brandName: "Should Not Apply" },
    });
    if (status === 401) {
      log("Settings update without auth → 401", "PASS");
    } else {
      log("Settings update without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // No valid fields → 400
  {
    const { status } = await call("PATCH", `/brands/${HUB_BRAND_ID}/settings`, {
      body: { status: "APPROVED", role: "ADMIN" }, // both in blocklist
      headers: brandHeaders(),
    });
    if (status === 400) {
      log("Blocked fields only → 400", "PASS");
    } else {
      log("Blocked fields only → 400", "FAIL", `status=${status}`);
    }
  }

  // Valid partial update
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/settings`, {
      body: {
        brandName:   "Updated Brand Name",
        description: "Updated description via test script.",
        themeColor:  "#8B5CF6",
        phone:       "+27 21 999 8888",
        address:     "99 Test Avenue, Cape Town",
      },
      headers: brandHeaders(),
    });
    if (status === 200 && data.brand) {
      log("Partial settings update", "PASS", `themeColor=${data.brand.themeColor}`);
    } else {
      log("Partial settings update", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // All allowed fields
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/settings`, {
      body: {
        brandName:   "Final Brand Name",
        companyName: "Final Company Ltd",
        description: "Full settings update test.",
        webLink:     "https://updated.com",
        appLink:     "https://apps.apple.com/updated",
        phone:       "+27 11 000 1234",
        address:     "1 Final Street, Johannesburg",
        themeColor:  "#F59E0B",
        domain:      "updated.com",
        contactName: "Updated Contact",
      },
      headers: brandHeaders(),
    });
    if (status === 200 && data.brand?.brandName === "Final Brand Name") {
      log("Full settings update", "PASS");
    } else {
      log("Full settings update", "FAIL", `status=${status}`);
    }
  }
}

async function testAnalytics() {
  section("Brand Analytics  GET /brands/:id/analytics");

  if (!HUB_BRAND_ID) {
    log("Analytics", "SKIP", "no HUB_BRAND_ID");
    return;
  }

  const { status, data } = await call("GET", `/brands/${HUB_BRAND_ID}/analytics`, {
    headers: brandHeaders(),
  });
  if (status === 200 && data.analytics?.summary) {
    const s = data.analytics.summary;
    log("Returns analytics summary", "PASS",
      `totalCampaigns=${s.totalCampaigns} redemptions=${s.totalRedemptions} uniqueUsers=${s.uniqueUsers}`);
  } else {
    log("Returns analytics summary", "FAIL", `status=${status}`);
  }
}

async function testCampaigns() {
  section("Campaigns  /brands/:id/campaigns");

  if (!HUB_BRAND_ID) {
    log("All campaign tests", "SKIP", "no HUB_BRAND_ID");
    return;
  }

  // GET — no auth → 401
  {
    const { status } = await call("GET", `/brands/${HUB_BRAND_ID}/campaigns`);
    if (status === 401) {
      log("GET campaigns without auth → 401", "PASS");
    } else {
      log("GET campaigns without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // GET — empty list (new brand)
  {
    const { status, data } = await call("GET", `/brands/${HUB_BRAND_ID}/campaigns`, {
      headers: brandHeaders(),
    });
    if (status === 200 && Array.isArray(data.campaigns)) {
      log("GET campaigns for brand", "PASS", `count=${data.campaigns.length}`);
    } else {
      log("GET campaigns for brand", "FAIL", `status=${status}`);
    }
  }

  // POST — missing name → 400
  {
    const { status } = await call("POST", `/brands/${HUB_BRAND_ID}/campaigns`, {
      body: { description: "No name provided" },
      headers: brandHeaders(),
    });
    if (status === 400) {
      log("POST without name → 400", "PASS");
    } else {
      log("POST without name → 400", "FAIL", `status=${status}`);
    }
  }

  // POST — minimal (name only)
  {
    const { status, data } = await call("POST", `/brands/${HUB_BRAND_ID}/campaigns`, {
      body: { name: "Minimal Campaign" },
      headers: brandHeaders(),
    });
    if (status === 201 && data.campaign?._id) {
      CAMPAIGN_ID = String(data.campaign._id);
      log("POST minimal campaign", "PASS", `id=${CAMPAIGN_ID} status=${data.campaign.status}`);
    } else {
      log("POST minimal campaign", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // POST — full fields (JSON)
  {
    const { status, data } = await call("POST", `/brands/${HUB_BRAND_ID}/campaigns`, {
      body: {
        name:            "Summer Recycling Drive",
        description:     "Earn double points for every drop-off this summer.",
        campaignType:    "seasonal",
        badge:           "Limited Time",
        subtitle:        "Double points all July",
        backgroundColor: "#0F172A",
        startDate:       "2026-07-01",
        endDate:         "2026-07-31",
        budget:          5000,
        targetAudience:  "Eco-conscious consumers aged 18-35",
      },
      headers: brandHeaders(),
    });
    if (status === 201 && data.campaign?._id) {
      log("POST full campaign (JSON)", "PASS", `name="${data.campaign.name}"`);
    } else {
      log("POST full campaign (JSON)", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // POST — with banner (multipart)
  {
    const fd = new FormData();
    fd.append("name",            "Banner Campaign");
    fd.append("description",     "Campaign with an uploaded banner.");
    fd.append("campaignType",    "brandAwareness");
    fd.append("backgroundColor", "#1E3A5F");
    fd.append("startDate",       "2026-08-01");
    fd.append("endDate",         "2026-08-31");
    fd.append("budget",          "3000");
    fd.append("banner", new Blob([TINY_PNG], { type: "image/png" }), "banner.png");
    const { status, data } = await call("POST", `/brands/${HUB_BRAND_ID}/campaigns`, {
      form: fd,
      headers: brandHeaders(),
    });
    if (status === 201 && data.campaign?.banner) {
      log("POST campaign with banner (multipart)", "PASS", `bannerUrl=${data.campaign.banner.slice(0, 60)}…`);
    } else {
      log("POST campaign with banner (multipart)", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // POST — non-image banner rejected
  {
    const fd = new FormData();
    fd.append("name",   "Bad Banner Campaign");
    fd.append("banner", new Blob(["not-an-image"], { type: "text/plain" }), "bad.txt");
    const { status, data } = await call("POST", `/brands/${HUB_BRAND_ID}/campaigns`, {
      form: fd,
      headers: brandHeaders(),
    });
    if (status === 400 && data.message?.toLowerCase().includes("image")) {
      log("POST non-image banner → 400", "PASS", data.message);
    } else {
      log("POST non-image banner → 400", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  if (!CAMPAIGN_ID) return;

  // PATCH — brand fields
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      body: {
        name:            "Updated Campaign",
        description:     "Updated description.",
        badge:           "Updated Badge",
        backgroundColor: "#1E3A5F",
        budget:          7500,
      },
      headers: brandHeaders(),
    });
    if (status === 200 && data.campaign?.name === "Updated Campaign") {
      log("PATCH campaign — brand fields", "PASS");
    } else {
      log("PATCH campaign — brand fields", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // PATCH — sending status as brand user (no admin) → 401
  {
    const { status } = await call("PATCH", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      body: { status: "APPROVED" },
      headers: brandHeaders(),
    });
    if (status === 401) {
      log("PATCH status without admin auth → 401", "PASS");
    } else {
      log("PATCH status without admin auth → 401", "FAIL", `status=${status}`);
    }
  }

  // PATCH — approve (brand + admin — the route requires both: brand-scope
  // gates the row, then the "status" field additionally requires admin)
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      body: { status: "APPROVED" },
      headers: adminHeaders(),
    });
    if (status === 200 && data.campaign?.status === "APPROVED") {
      log("PATCH approve campaign (admin)", "PASS");
    } else {
      log("PATCH approve campaign (admin)", "FAIL", `status=${status} campaignStatus=${data.campaign?.status}`);
    }
  }

  // PATCH — reject (brand + admin)
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      body: { status: "REJECTED" },
      headers: adminHeaders(),
    });
    if (status === 200 && data.campaign?.status === "REJECTED") {
      log("PATCH reject campaign (admin)", "PASS");
    } else {
      log("PATCH reject campaign (admin)", "FAIL", `status=${status}`);
    }
  }

  // PATCH — replace banner (multipart)
  {
    const fd = new FormData();
    fd.append("name",   "Campaign With Replaced Banner");
    fd.append("banner", new Blob([TINY_PNG], { type: "image/png" }), "new-banner.png");
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      form: fd,
      headers: brandHeaders(),
    });
    if (status === 200 && data.campaign?.banner) {
      log("PATCH replace banner (multipart)", "PASS");
    } else {
      log("PATCH replace banner (multipart)", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // PATCH — no valid fields → 400
  {
    const { status } = await call("PATCH", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      body: { role: "ADMIN", unknown: "field" },
      headers: brandHeaders(),
    });
    if (status === 400) {
      log("PATCH unknown fields only → 400", "PASS");
    } else {
      log("PATCH unknown fields only → 400", "FAIL", `status=${status}`);
    }
  }

  // DELETE — no auth → 401
  {
    const { status } = await call("DELETE", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`);
    if (status === 401) {
      log("DELETE campaign without auth → 401", "PASS");
    } else {
      log("DELETE campaign without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // DELETE
  {
    const { status, data } = await call("DELETE", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      headers: brandHeaders(),
    });
    if (status === 200 && data.success) {
      log("DELETE campaign", "PASS");
    } else {
      log("DELETE campaign", "FAIL", `status=${status}`);
    }
  }

  // DELETE again → 404
  {
    const { status } = await call("DELETE", `/brands/${HUB_BRAND_ID}/campaigns/${CAMPAIGN_ID}`, {
      headers: brandHeaders(),
    });
    if (status === 404) {
      log("DELETE already-deleted campaign → 404", "PASS");
    } else {
      log("DELETE already-deleted campaign → 404", "FAIL", `status=${status}`);
    }
  }
}

async function testDeals() {
  section("Deals  /brands/:id/deals");

  if (!HUB_BRAND_ID) {
    log("All deal tests", "SKIP", "no HUB_BRAND_ID");
    return;
  }

  // GET — no auth → 401
  {
    const { status } = await call("GET", `/brands/${HUB_BRAND_ID}/deals`);
    if (status === 401) {
      log("GET deals without auth → 401", "PASS");
    } else {
      log("GET deals without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // GET — list
  {
    const { status, data } = await call("GET", `/brands/${HUB_BRAND_ID}/deals`, {
      headers: brandHeaders(),
    });
    if (status === 200 && Array.isArray(data.deals)) {
      log("GET deals for brand", "PASS", `count=${data.deals.length}`);
    } else {
      log("GET deals for brand", "FAIL", `status=${status}`);
    }
  }

  // POST — missing title → 400
  {
    const { status } = await call("POST", `/brands/${HUB_BRAND_ID}/deals`, {
      body: { description: "No title" },
      headers: brandHeaders(),
    });
    if (status === 400) {
      log("POST without title → 400", "PASS");
    } else {
      log("POST without title → 400", "FAIL", `status=${status}`);
    }
  }

  // POST — minimal
  {
    const { status, data } = await call("POST", `/brands/${HUB_BRAND_ID}/deals`, {
      body: { title: "Minimal Deal" },
      headers: brandHeaders(),
    });
    if (status === 201 && data.deal?._id) {
      DEAL_ID = String(data.deal._id);
      log("POST minimal deal", "PASS", `id=${DEAL_ID} status=${data.deal.status}`);
    } else {
      log("POST minimal deal", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  // POST — full fields
  {
    const { status, data } = await call("POST", `/brands/${HUB_BRAND_ID}/deals`, {
      body: {
        title:              "20% Off Storewide",
        description:        "Exclusive discount for MintRewards members.",
        discountPercentage: 20,
        promoCode:          "MINT20",
        startDate:          "2026-07-01",
        endDate:            "2026-07-31",
        maxUses:            500,
        minimumPurchase:    50,
      },
      headers: brandHeaders(),
    });
    if (status === 201 && data.deal?.promoCode === "MINT20") {
      log("POST full deal", "PASS", `promoCode=${data.deal.promoCode}`);
    } else {
      log("POST full deal", "FAIL", `status=${status} msg="${data.message}"`);
    }
  }

  if (!DEAL_ID) return;

  // PATCH — update content fields
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`, {
      body: {
        title:              "25% Off Storewide",
        discountPercentage: 25,
        promoCode:          "MINT25",
        endDate:            "2026-08-31",
        maxUses:            1000,
      },
      headers: brandHeaders(),
    });
    if (status === 200 && data.deal?.title === "25% Off Storewide") {
      log("PATCH deal — content fields", "PASS");
    } else {
      log("PATCH deal — content fields", "FAIL", `status=${status}`);
    }
  }

  // PATCH — deactivate (status field requires brand + admin auth)
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`, {
      body: { status: "inactive" },
      headers: adminHeaders(),
    });
    if (status === 200 && data.deal?.status === "inactive") {
      log("PATCH deactivate deal", "PASS");
    } else {
      log("PATCH deactivate deal", "FAIL", `status=${status}`);
    }
  }

  // PATCH — reactivate
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`, {
      body: { status: "active" },
      headers: adminHeaders(),
    });
    if (status === 200 && data.deal?.status === "active") {
      log("PATCH reactivate deal", "PASS");
    } else {
      log("PATCH reactivate deal", "FAIL", `status=${status}`);
    }
  }

  // PATCH — expire manually
  {
    const { status, data } = await call("PATCH", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`, {
      body: { status: "expired" },
      headers: adminHeaders(),
    });
    if (status === 200 && data.deal?.status === "expired") {
      log("PATCH expire deal manually", "PASS");
    } else {
      log("PATCH expire deal manually", "FAIL", `status=${status}`);
    }
  }

  // PATCH — no valid fields → 400
  {
    const { status } = await call("PATCH", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`, {
      body: { brand: "hijack", role: "ADMIN" },
      headers: brandHeaders(),
    });
    if (status === 400) {
      log("PATCH unknown fields only → 400", "PASS");
    } else {
      log("PATCH unknown fields only → 400", "FAIL", `status=${status}`);
    }
  }

  // DELETE — no auth → 401
  {
    const { status } = await call("DELETE", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`);
    if (status === 401) {
      log("DELETE deal without auth → 401", "PASS");
    } else {
      log("DELETE deal without auth → 401", "FAIL", `status=${status}`);
    }
  }

  // DELETE
  {
    const { status, data } = await call("DELETE", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`, {
      headers: brandHeaders(),
    });
    if (status === 200 && data.success) {
      log("DELETE deal", "PASS");
    } else {
      log("DELETE deal", "FAIL", `status=${status}`);
    }
  }

  // DELETE again → 404
  {
    const { status } = await call("DELETE", `/brands/${HUB_BRAND_ID}/deals/${DEAL_ID}`, {
      headers: brandHeaders(),
    });
    if (status === 404) {
      log("DELETE already-deleted deal → 404", "PASS");
    } else {
      log("DELETE already-deleted deal → 404", "FAIL", `status=${status}`);
    }
  }
}

async function testAdminViews() {
  section("Admin Views  /brands/campaigns  /brands/deals");

  // GET all campaigns — unfiltered
  {
    const { status, data } = await call("GET", "/brands/campaigns", { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.campaigns)) {
      log("GET /brands/campaigns (all)", "PASS", `count=${data.campaigns.length}`);
    } else {
      log("GET /brands/campaigns (all)", "FAIL", `status=${status}`);
    }
  }

  // GET campaigns — filter by status
  for (const s of ["PENDING", "APPROVED", "REJECTED", "EXPIRED"]) {
    const { status, data } = await call("GET", `/brands/campaigns?status=${s}`, { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.campaigns)) {
      log(`GET /brands/campaigns?status=${s}`, "PASS", `count=${data.campaigns.length}`);
    } else {
      log(`GET /brands/campaigns?status=${s}`, "FAIL", `status=${status}`);
    }
  }

  // GET campaigns — filter by brandId
  if (BRAND_ID) {
    const { status, data } = await call("GET", `/brands/campaigns?brandId=${BRAND_ID}`, { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.campaigns)) {
      log("GET /brands/campaigns?brandId=…", "PASS", `count=${data.campaigns.length}`);
    } else {
      log("GET /brands/campaigns?brandId=…", "FAIL", `status=${status}`);
    }
  }

  // GET all deals — unfiltered
  {
    const { status, data } = await call("GET", "/brands/deals", { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.deals)) {
      log("GET /brands/deals (all)", "PASS", `count=${data.deals.length}`);
    } else {
      log("GET /brands/deals (all)", "FAIL", `status=${status}`);
    }
  }

  // GET deals — filter by status
  for (const s of ["active", "inactive", "expired"]) {
    const { status, data } = await call("GET", `/brands/deals?status=${s}`, { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.deals)) {
      log(`GET /brands/deals?status=${s}`, "PASS", `count=${data.deals.length}`);
    } else {
      log(`GET /brands/deals?status=${s}`, "FAIL", `status=${status}`);
    }
  }

  // GET deals — filter by brandId
  if (BRAND_ID) {
    const { status, data } = await call("GET", `/brands/deals?brandId=${BRAND_ID}`, { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.deals)) {
      log("GET /brands/deals?brandId=…", "PASS", `count=${data.deals.length}`);
    } else {
      log("GET /brands/deals?brandId=…", "FAIL", `status=${status}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Additional coverage: admin-login negatives, MintRewards app-user auth &
// profile, social sign-in, BrandHub auth/brands/modules, coupons, logs.
// All data is created fresh per run (unique emails/reg numbers) so nothing
// depends on external/production state.
// ═══════════════════════════════════════════════════════════════════════════

// Signs up a fresh MintRewards *app* user and captures its id-based JWT.
// Not fatal if it fails — dependent suites simply SKIP.
async function registerAppUser() {
  section("Auth  POST /users/signup (app user setup)");
  const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  USER_EMAIL = `appuser${unique}@testuser.com`;
  USER_PASSWORD = "AppUserPass123!";
  const { status, data } = await call("POST", "/users/signup", {
    body: {
      userName: `App User ${unique}`,
      email: USER_EMAIL,
      password: USER_PASSWORD,
      confirmPassword: USER_PASSWORD,
      phone: "+27 82 111 2222",
      address: "1 App Street, Cape Town",
    },
  });
  if (status === 200 && data.token) {
    USER_TOKEN = data.token; // already "Bearer <jwt>"
    USER_ID = String(data.user?._id ?? data.user?.id ?? "");
    log("App user signup", "PASS", `mintId=${data.user?.mintId} points=${data.user?.points}`);
  } else {
    log("App user signup", "FAIL", `status=${status} msg="${data.error}"`);
  }
}

async function testAdminLoginNegative() {
  section("Admin Login negatives  POST /admin/login");

  // Missing password → 400
  {
    const { status } = await call("POST", "/admin/login", { body: { email: ADMIN_EMAIL } });
    if (status === 400) log("Missing password → 400", "PASS");
    else log("Missing password → 400", "FAIL", `status=${status}`);
  }

  // Empty body → 400
  {
    const { status } = await call("POST", "/admin/login", { body: {} });
    if (status === 400) log("Empty body → 400", "PASS");
    else log("Empty body → 400", "FAIL", `status=${status}`);
  }

  // Wrong password → 401
  {
    const { status } = await call("POST", "/admin/login", {
      body: { email: ADMIN_EMAIL, password: "definitely-wrong-password" },
    });
    if (status === 401) log("Wrong password → 401", "PASS");
    else log("Wrong password → 401", "FAIL", `status=${status}`);
  }

  // Unknown email → 401
  {
    const { status } = await call("POST", "/admin/login", {
      body: { email: `nobody${Date.now()}@nowhere.com`, password: "whatever123" },
    });
    if (status === 401) log("Unknown email → 401", "PASS");
    else log("Unknown email → 401", "FAIL", `status=${status}`);
  }
}

async function testUserSignup() {
  section("User Signup  POST /users/signup");

  // GET liveness probe
  {
    const { status, data } = await call("GET", "/users/signup");
    if (status === 200 && /alive/i.test(data.message || "")) log("GET liveness → alive", "PASS");
    else log("GET liveness → alive", "FAIL", `status=${status}`);
  }

  // Missing required fields → 410 (this API uses non-standard 41x codes)
  {
    const { status } = await call("POST", "/users/signup", { body: { email: "x@y.com" } });
    if (status === 410) log("Missing fields → 410", "PASS");
    else log("Missing fields → 410", "FAIL", `status=${status}`);
  }

  // Invalid email format → 411
  {
    const { status } = await call("POST", "/users/signup", {
      body: { userName: "Bad Email", email: "not-an-email", password: "Password123!", confirmPassword: "Password123!" },
    });
    if (status === 411) log("Invalid email format → 411", "PASS");
    else log("Invalid email format → 411", "FAIL", `status=${status}`);
  }

  // Password mismatch → 412
  {
    const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const { status } = await call("POST", "/users/signup", {
      body: { userName: "Mismatch", email: `mismatch${unique}@testuser.com`, password: "Password123!", confirmPassword: "Different123!" },
    });
    if (status === 412) log("Password mismatch → 412", "PASS");
    else log("Password mismatch → 412", "FAIL", `status=${status}`);
  }

  // Duplicate email → 413 (reuse the main app user's email)
  if (USER_EMAIL) {
    const { status } = await call("POST", "/users/signup", {
      body: { userName: "Dupe", email: USER_EMAIL, password: "Password123!", confirmPassword: "Password123!" },
    });
    if (status === 413) log("Duplicate email → 413", "PASS");
    else log("Duplicate email → 413", "FAIL", `status=${status}`);
  } else {
    log("Duplicate email → 413", "SKIP", "no USER_EMAIL");
  }

  // Email case-insensitivity: signup lowercases, so an uppercased dupe also 413s
  if (USER_EMAIL) {
    const { status } = await call("POST", "/users/signup", {
      body: { userName: "DupeUpper", email: USER_EMAIL.toUpperCase(), password: "Password123!", confirmPassword: "Password123!" },
    });
    if (status === 413) log("Duplicate email (uppercased) → 413", "PASS");
    else log("Duplicate email (uppercased) → 413", "FAIL", `status=${status}`);
  }
}

async function testUserLogin() {
  section("User Login  POST /users/login");

  // GET liveness probe
  {
    const { status, data } = await call("GET", "/users/login");
    if (status === 200 && /alive/i.test(data.message || "")) log("GET liveness → alive", "PASS");
    else log("GET liveness → alive", "FAIL", `status=${status}`);
  }

  // Missing email → 400
  {
    const { status } = await call("POST", "/users/login", { body: { password: "x" } });
    if (status === 400) log("Missing email → 400", "PASS");
    else log("Missing email → 400", "FAIL", `status=${status}`);
  }

  // Missing password → 400
  {
    const { status } = await call("POST", "/users/login", { body: { email: "x@y.com" } });
    if (status === 400) log("Missing password → 400", "PASS");
    else log("Missing password → 400", "FAIL", `status=${status}`);
  }

  // Wrong password for existing user → 401 (kept under the 5/15min email limit)
  if (USER_EMAIL) {
    const { status } = await call("POST", "/users/login", {
      body: { email: USER_EMAIL, password: "wrong-password-here" },
    });
    if (status === 401) log("Wrong password → 401", "PASS");
    else log("Wrong password → 401", "FAIL", `status=${status}`);
  }

  // Successful login → 200 + Bearer token
  if (USER_EMAIL) {
    const { status, data } = await call("POST", "/users/login", {
      body: { email: USER_EMAIL, password: USER_PASSWORD },
    });
    if (status === 200 && data.success && String(data.token).startsWith("Bearer ")) {
      log("Valid login → 200 + token", "PASS");
    } else {
      log("Valid login → 200 + token", "FAIL", `status=${status}`);
    }
  } else {
    log("Valid login → 200 + token", "SKIP", "no USER_EMAIL");
  }

  // Login with unknown email returns the same 401 (no user enumeration)
  {
    const { status } = await call("POST", "/users/login", {
      body: { email: `ghost${Date.now()}@nowhere.com`, password: "whatever123" },
    });
    if (status === 401) log("Unknown email → 401 (no enumeration)", "PASS");
    else log("Unknown email → 401 (no enumeration)", "FAIL", `status=${status}`);
  }
}

async function testPasswordReset() {
  section("Password Reset  /users/reset-password · verify-otp · set-password");

  // reset-password missing email → 400
  {
    const { status } = await call("POST", "/users/reset-password", { body: {} });
    if (status === 400) log("reset-password missing email → 400", "PASS");
    else log("reset-password missing email → 400", "FAIL", `status=${status}`);
  }

  // reset-password non-string email → 400
  {
    const { status } = await call("POST", "/users/reset-password", { body: { email: 12345 } });
    if (status === 400) log("reset-password non-string email → 400", "PASS");
    else log("reset-password non-string email → 400", "FAIL", `status=${status}`);
  }

  // reset-password unknown email → 200 generic (no enumeration)
  {
    const { status, data } = await call("POST", "/users/reset-password", {
      body: { email: `ghost${Date.now()}@nowhere.com` },
    });
    if (status === 200 && /if an account exists/i.test(data.message || "")) {
      log("reset-password unknown email → 200 generic", "PASS");
    } else {
      log("reset-password unknown email → 200 generic", "FAIL", `status=${status}`);
    }
  }

  // reset-password existing email → 200 generic (same response shape)
  if (USER_EMAIL) {
    const { status, data } = await call("POST", "/users/reset-password", { body: { email: USER_EMAIL } });
    if (status === 200 && /if an account exists/i.test(data.message || "")) {
      log("reset-password existing email → 200 generic", "PASS");
    } else {
      log("reset-password existing email → 200 generic", "FAIL", `status=${status}`);
    }
  }

  // verify-otp missing fields → 400
  {
    const { status } = await call("POST", "/users/verify-otp", { body: { email: USER_EMAIL || "x@y.com" } });
    if (status === 400) log("verify-otp missing otp → 400", "PASS");
    else log("verify-otp missing otp → 400", "FAIL", `status=${status}`);
  }

  // verify-otp wrong code → 400 generic (can't know the real emailed OTP)
  {
    const { status } = await call("POST", "/users/verify-otp", {
      body: { email: USER_EMAIL || `nobody${Date.now()}@x.com`, otp: "000000" },
    });
    if (status === 400) log("verify-otp wrong code → 400 generic", "PASS");
    else log("verify-otp wrong code → 400 generic", "FAIL", `status=${status}`);
  }

  // set-password missing password → 400
  {
    const { status } = await call("POST", "/users/set-password", { body: { resetToken: "x" } });
    if (status === 400) log("set-password missing password → 400", "PASS");
    else log("set-password missing password → 400", "FAIL", `status=${status}`);
  }

  // set-password too short → 400
  {
    const { status } = await call("POST", "/users/set-password", {
      body: { resetToken: "x", password: "short" },
    });
    if (status === 400) log("set-password < 8 chars → 400", "PASS");
    else log("set-password < 8 chars → 400", "FAIL", `status=${status}`);
  }

  // set-password missing token → 401
  {
    const { status } = await call("POST", "/users/set-password", { body: { password: "longenough123" } });
    if (status === 401) log("set-password missing token → 401", "PASS");
    else log("set-password missing token → 401", "FAIL", `status=${status}`);
  }

  // set-password invalid/forged token → 401
  {
    const { status } = await call("POST", "/users/set-password", {
      body: { password: "longenough123", resetToken: "not.a.valid.jwt" },
    });
    if (status === 401) log("set-password invalid token → 401", "PASS");
    else log("set-password invalid token → 401", "FAIL", `status=${status}`);
  }
}

async function testUserProfile() {
  section("User Profile  /users/my-profile · update-profile");

  // GET my-profile without auth → 401
  {
    const { status } = await call("GET", "/users/my-profile");
    if (status === 401) log("GET my-profile without auth → 401", "PASS");
    else log("GET my-profile without auth → 401", "FAIL", `status=${status}`);
  }

  // GET my-profile with a malformed token → 401
  {
    const { status } = await call("GET", "/users/my-profile", {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    if (status === 401) log("GET my-profile malformed token → 401", "PASS");
    else log("GET my-profile malformed token → 401", "FAIL", `status=${status}`);
  }

  if (!USER_TOKEN) {
    log("Authenticated profile tests", "SKIP", "no USER_TOKEN");
    return;
  }

  // GET my-profile authenticated → 200, password never leaks
  {
    const { status, data } = await call("GET", "/users/my-profile", { headers: userHeaders() });
    if (status === 200 && data.user && data.user.password === undefined) {
      log("GET my-profile authenticated → 200 (no password)", "PASS", `email=${data.user.email}`);
    } else {
      log("GET my-profile authenticated → 200 (no password)", "FAIL", `status=${status} hasPw=${data.user?.password !== undefined}`);
    }
  }

  // PUT update-profile without auth → 401
  {
    const { status } = await call("PUT", "/users/update-profile", { body: { userName: "Nope" } });
    if (status === 401) log("PUT update-profile without auth → 401", "PASS");
    else log("PUT update-profile without auth → 401", "FAIL", `status=${status}`);
  }

  // PUT update-profile authenticated → 200 + fields applied
  {
    const { status, data } = await call("PUT", "/users/update-profile", {
      body: { userName: "Updated App User", phone: "+27 21 555 0000", city: "Cape Town", firstTimeLogin: false },
      headers: userHeaders(),
    });
    if (status === 200 && data.userName === "Updated App User") {
      log("PUT update-profile → 200 (fields applied)", "PASS");
    } else {
      log("PUT update-profile → 200 (fields applied)", "FAIL", `status=${status}`);
    }
  }
}

async function testDeleteAccount() {
  section("Delete Account  DELETE /users/delete-account");

  // No auth → 401
  {
    const { status } = await call("DELETE", "/users/delete-account");
    if (status === 401) log("DELETE without auth → 401", "PASS");
    else log("DELETE without auth → 401", "FAIL", `status=${status}`);
  }

  // Create a throwaway user, delete it, then confirm its token is dead.
  const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const throwawayEmail = `throwaway${unique}@testuser.com`;
  const pw = "ThrowawayPass123!";
  const signup = await call("POST", "/users/signup", {
    body: { userName: `Throwaway ${unique}`, email: throwawayEmail, password: pw, confirmPassword: pw },
  });

  if (signup.status !== 200 || !signup.data.token) {
    log("Delete own account → 200", "SKIP", "could not create throwaway user");
    return;
  }
  const throwawayHeaders = { Authorization: signup.data.token };

  // Delete own account → 200
  {
    const { status, data } = await call("DELETE", "/users/delete-account", { headers: throwawayHeaders });
    if (status === 200 && /deleted/i.test(data.message || "")) {
      log("Delete own account → 200", "PASS");
    } else {
      log("Delete own account → 200", "FAIL", `status=${status}`);
    }
  }

  // Deleting again with the same (now-orphaned) token → 404
  {
    const { status } = await call("DELETE", "/users/delete-account", { headers: throwawayHeaders });
    if (status === 404) log("Delete already-deleted account → 404", "PASS");
    else log("Delete already-deleted account → 404", "FAIL", `status=${status}`);
  }
}

async function testUserDiscounts() {
  section("User Discounts  /users/my-discounts (GET · PATCH · PUT)");

  // GET no auth → 401
  {
    const { status } = await call("GET", "/users/my-discounts");
    if (status === 401) log("GET my-discounts no auth → 401", "PASS");
    else log("GET my-discounts no auth → 401", "FAIL", `status=${status}`);
  }

  if (!USER_TOKEN) {
    log("Authenticated discount tests", "SKIP", "no USER_TOKEN");
    return;
  }

  // GET → 200 with discounts array
  {
    const { status, data } = await call("GET", "/users/my-discounts", { headers: userHeaders() });
    if (status === 200 && Array.isArray(data.discounts)) {
      log("GET my-discounts → 200 array", "PASS", `count=${data.discounts.length}`);
    } else {
      log("GET my-discounts → 200 array", "FAIL", `status=${status}`);
    }
  }

  // PATCH no auth → 401
  {
    const { status } = await call("PATCH", "/users/my-discounts", { body: { discountId: "x" } });
    if (status === 401) log("PATCH my-discounts no auth → 401", "PASS");
    else log("PATCH my-discounts no auth → 401", "FAIL", `status=${status}`);
  }

  // PATCH missing discountId → 400
  {
    const { status } = await call("PATCH", "/users/my-discounts", { body: {}, headers: userHeaders() });
    if (status === 400) log("PATCH missing discountId → 400", "PASS");
    else log("PATCH missing discountId → 400", "FAIL", `status=${status}`);
  }

  // PATCH non-existent campaign → 404
  {
    const { status } = await call("PATCH", "/users/my-discounts", {
      body: { discountId: "000000000000000000000000" }, headers: userHeaders(),
    });
    if (status === 404) log("PATCH non-existent campaign → 404", "PASS");
    else log("PATCH non-existent campaign → 404", "FAIL", `status=${status}`);
  }

  // PUT missing discountId → 400
  {
    const { status } = await call("PUT", "/users/my-discounts", { body: {}, headers: userHeaders() });
    if (status === 400) log("PUT missing discountId → 400", "PASS");
    else log("PUT missing discountId → 400", "FAIL", `status=${status}`);
  }

  // PUT non-existent campaign → 404
  {
    const { status } = await call("PUT", "/users/my-discounts", {
      body: { discountId: "000000000000000000000000" }, headers: userHeaders(),
    });
    if (status === 404) log("PUT non-existent campaign → 404", "PASS");
    else log("PUT non-existent campaign → 404", "FAIL", `status=${status}`);
  }
}

async function testReferrals() {
  section("Referrals  POST /users/referrals");

  // No auth → 401
  {
    const { status } = await call("POST", "/users/referrals", { body: { emails: ["a@b.com"] } });
    if (status === 401) log("referrals no auth → 401", "PASS");
    else log("referrals no auth → 401", "FAIL", `status=${status}`);
  }

  if (!USER_TOKEN) {
    log("Authenticated referral tests", "SKIP", "no USER_TOKEN");
    return;
  }

  // Empty / missing emails → 400
  {
    const { status } = await call("POST", "/users/referrals", { body: { emails: [] }, headers: userHeaders() });
    if (status === 400) log("referrals empty list → 400", "PASS");
    else log("referrals empty list → 400", "FAIL", `status=${status}`);
  }

  // Non-array emails → 400 (normalizes to empty)
  {
    const { status } = await call("POST", "/users/referrals", { body: { emails: "not-array" }, headers: userHeaders() });
    if (status === 400) log("referrals non-array → 400", "PASS");
    else log("referrals non-array → 400", "FAIL", `status=${status}`);
  }

  // Valid fresh emails → 200 success
  {
    const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const { status } = await call("POST", "/users/referrals", {
      body: { emails: [`referral${unique}@friend.com`, `referral2${unique}@friend.com`] },
      headers: userHeaders(),
    });
    if (status === 200) log("referrals valid emails → 200", "PASS");
    else log("referrals valid emails → 200", "FAIL", `status=${status}`);
  }
}

async function testActiveCampaigns() {
  section("Active Campaigns  GET /users/active-campaigns");

  // No auth → 401
  {
    const { status } = await call("GET", "/users/active-campaigns");
    if (status === 401) log("active-campaigns no auth → 401", "PASS");
    else log("active-campaigns no auth → 401", "FAIL", `status=${status}`);
  }

  if (!USER_TOKEN) {
    log("Authenticated active-campaigns test", "SKIP", "no USER_TOKEN");
    return;
  }

  // Authenticated → 200 with activeBrands + activeCampaigns arrays
  {
    const { status, data } = await call("GET", "/users/active-campaigns", { headers: userHeaders() });
    if (status === 200 && Array.isArray(data.activeBrands) && Array.isArray(data.activeCampaigns)) {
      log("active-campaigns → 200 arrays", "PASS",
        `brands=${data.activeBrands.length} campaigns=${data.activeCampaigns.length}`);
    } else {
      log("active-campaigns → 200 arrays", "FAIL", `status=${status}`);
    }
  }
}

async function testSocialAuth() {
  section("Social Auth  POST /auth/google · /auth/apple");

  // Google: no idToken → 400
  {
    const { status } = await call("POST", "/auth/google", { body: {} });
    if (status === 400) log("google missing idToken → 400", "PASS");
    else log("google missing idToken → 400", "FAIL", `status=${status}`);
  }

  // Google: bogus idToken → 401 (fails Google verification)
  {
    const { status } = await call("POST", "/auth/google", { body: { idToken: "clearly-not-a-real-google-token" } });
    if (status === 401) log("google invalid idToken → 401", "PASS");
    else log("google invalid idToken → 401", "FAIL", `status=${status}`);
  }

  // Apple: no identityToken → 400
  {
    const { status } = await call("POST", "/auth/apple", { body: {} });
    if (status === 400) log("apple missing identityToken → 400", "PASS");
    else log("apple missing identityToken → 400", "FAIL", `status=${status}`);
  }

  // Apple: bogus identityToken → not a success (401 config-missing sub, or 500 verify throw)
  {
    const { status } = await call("POST", "/auth/apple", { body: { identityToken: "clearly-not-a-real-apple-token" } });
    if (status === 401 || status === 500) log("apple invalid identityToken → 401/500", "PASS", `status=${status}`);
    else log("apple invalid identityToken → 401/500", "FAIL", `status=${status}`);
  }
}

async function testBrandhubAuth() {
  section("BrandHub Auth  /brandhub/auth/register · login");

  // register missing fields → 400
  {
    const { status } = await call("POST", "/brandhub/auth/register", { body: { email: "x@y.com" } });
    if (status === 400) log("register missing fields → 400", "PASS");
    else log("register missing fields → 400", "FAIL", `status=${status}`);
  }

  // register short password → 400
  {
    const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const { status } = await call("POST", "/brandhub/auth/register", {
      body: { orgName: `Org ${unique}`, email: `short${unique}@org.com`, password: "short" },
    });
    if (status === 400) log("register short password → 400", "PASS");
    else log("register short password → 400", "FAIL", `status=${status}`);
  }

  // register duplicate email → 409 (the brand owner from setup)
  {
    // Re-register the same email used in registerBrandUser is tricky (unique
    // per run); instead register once, then again, to force the 409.
    const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `dupbrand${unique}@org.com`;
    const first = await call("POST", "/brandhub/auth/register", {
      body: { orgName: `Org ${unique}`, email, password: "ValidPass123!" },
    });
    const second = await call("POST", "/brandhub/auth/register", {
      body: { orgName: `Org2 ${unique}`, email, password: "ValidPass123!" },
    });
    if (first.status === 201 && second.status === 409) {
      log("register duplicate email → 409", "PASS");
    } else {
      log("register duplicate email → 409", "FAIL", `first=${first.status} second=${second.status}`);
    }
  }

  // login missing fields → 400
  {
    const { status } = await call("POST", "/brandhub/auth/login", { body: { email: "x@y.com" } });
    if (status === 400) log("login missing password → 400", "PASS");
    else log("login missing password → 400", "FAIL", `status=${status}`);
  }

  // login wrong credentials → 401
  {
    const { status } = await call("POST", "/brandhub/auth/login", {
      body: { email: `nobody${Date.now()}@org.com`, password: "whatever123" },
    });
    if (status === 401) log("login wrong credentials → 401", "PASS");
    else log("login wrong credentials → 401", "FAIL", `status=${status}`);
  }
}

async function testBrandhubBrands() {
  section("BrandHub Brands  /brandhub/brands · /brandhub/brands/:id");

  // GET list no auth → 401
  {
    const { status } = await call("GET", "/brandhub/brands");
    if (status === 401) log("GET brandhub brands no auth → 401", "PASS");
    else log("GET brandhub brands no auth → 401", "FAIL", `status=${status}`);
  }

  if (!BRAND_TOKEN) {
    log("Authenticated brandhub brand tests", "SKIP", "no BRAND_TOKEN");
    return;
  }

  // GET list authenticated → 200 with brands array
  {
    const { status, data } = await call("GET", "/brandhub/brands", { headers: brandHeaders() });
    if (status === 200 && Array.isArray(data.brands)) {
      log("GET brandhub brands → 200 array", "PASS", `count=${data.brands.length}`);
    } else {
      log("GET brandhub brands → 200 array", "FAIL", `status=${status}`);
    }
  }

  // POST create no auth → 401
  {
    const { status } = await call("POST", "/brandhub/brands", { body: { brandName: "X", companyName: "Y" } });
    if (status === 401) log("POST brandhub brand no auth → 401", "PASS");
    else log("POST brandhub brand no auth → 401", "FAIL", `status=${status}`);
  }

  // POST missing fields → 400
  {
    const { status } = await call("POST", "/brandhub/brands", { body: { brandName: "OnlyName" }, headers: brandHeaders() });
    if (status === 400) log("POST brandhub brand missing companyName → 400", "PASS");
    else log("POST brandhub brand missing companyName → 400", "FAIL", `status=${status}`);
  }

  // POST valid (owner) → 201
  {
    const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const { status, data } = await call("POST", "/brandhub/brands", {
      body: { brandName: `Hub Brand ${unique}`, companyName: `Hub Co ${unique}` },
      headers: brandHeaders(),
    });
    if (status === 201 && data.brand?.id) {
      NEW_HUB_BRAND_ID = String(data.brand.id);
      log("POST brandhub brand (owner) → 201", "PASS", `id=${NEW_HUB_BRAND_ID}`);
    } else {
      log("POST brandhub brand (owner) → 201", "FAIL", `status=${status}`);
    }
  }

  // GET one brand no auth → 401
  if (HUB_BRAND_ID) {
    const { status } = await call("GET", `/brandhub/brands/${HUB_BRAND_ID}`);
    if (status === 401) log("GET brandhub brand :id no auth → 401", "PASS");
    else log("GET brandhub brand :id no auth → 401", "FAIL", `status=${status}`);
  }

  // GET own brand → 200
  if (HUB_BRAND_ID) {
    const { status, data } = await call("GET", `/brandhub/brands/${HUB_BRAND_ID}`, { headers: brandHeaders() });
    if (status === 200 && data.brand?.id) {
      log("GET brandhub own brand → 200", "PASS");
    } else {
      log("GET brandhub own brand → 200", "FAIL", `status=${status}`);
    }
  }

  // GET brand outside caller's org (nonexistent id) → 404 (scope hides existence)
  {
    const { status } = await call("GET", "/brandhub/brands/000000000000000000000000", { headers: brandHeaders() });
    if (status === 404) log("GET brandhub foreign/nonexistent brand → 404", "PASS");
    else log("GET brandhub foreign/nonexistent brand → 404", "FAIL", `status=${status}`);
  }

  // GET brand with malformed id → 404 (invalid ObjectId short-circuits in scope)
  {
    const { status } = await call("GET", "/brandhub/brands/not-an-object-id", { headers: brandHeaders() });
    if (status === 404) log("GET brandhub malformed brand id → 404", "PASS");
    else log("GET brandhub malformed brand id → 404", "FAIL", `status=${status}`);
  }
}

async function testBrandhubModules() {
  section("BrandHub Modules  GET/POST /brandhub/modules/:module");

  // Unknown module → 404 (checked before auth, so no token needed)
  {
    const { status } = await call("GET", "/brandhub/modules/definitely-not-a-module");
    if (status === 404) log("unknown module → 404", "PASS");
    else log("unknown module → 404", "FAIL", `status=${status}`);
  }

  // Valid module, no auth → 401
  {
    const { status } = await call("GET", "/brandhub/modules/b2c");
    if (status === 401) log("valid module no auth → 401", "PASS");
    else log("valid module no auth → 401", "FAIL", `status=${status}`);
  }

  if (!BRAND_TOKEN) {
    log("Authenticated module tests", "SKIP", "no BRAND_TOKEN");
    return;
  }

  // Valid module, authenticated, but org has no active subscription → 402
  {
    const { status } = await call("GET", "/brandhub/modules/b2c", { headers: brandHeaders() });
    if (status === 402) log("valid module, no subscription → 402 (GET)", "PASS");
    else log("valid module, no subscription → 402 (GET)", "FAIL", `status=${status}`);
  }

  // POST (write) same story → 402
  {
    const { status } = await call("POST", "/brandhub/modules/analytics", { body: { foo: "bar" }, headers: brandHeaders() });
    if (status === 402) log("valid module, no subscription → 402 (POST)", "PASS");
    else log("valid module, no subscription → 402 (POST)", "FAIL", `status=${status}`);
  }

  // Unknown module still 404 even with a valid token
  {
    const { status } = await call("POST", "/brandhub/modules/bogus", { body: {}, headers: brandHeaders() });
    if (status === 404) log("unknown module (authed) → 404", "PASS");
    else log("unknown module (authed) → 404", "FAIL", `status=${status}`);
  }
}

async function testCoupons() {
  section("Coupons  PATCH /coupons/:couponId/redeem");

  // No auth → 401
  {
    const { status } = await call("PATCH", "/coupons/000000000000000000000000/redeem");
    if (status === 401) log("redeem no auth → 401", "PASS");
    else log("redeem no auth → 401", "FAIL", `status=${status}`);
  }

  if (!USER_TOKEN) {
    log("Authenticated coupon tests", "SKIP", "no USER_TOKEN");
    return;
  }

  // Malformed coupon id → 400
  {
    const { status } = await call("PATCH", "/coupons/not-an-object-id/redeem", { headers: userHeaders() });
    if (status === 400) log("redeem malformed id → 400", "PASS");
    else log("redeem malformed id → 400", "FAIL", `status=${status}`);
  }

  // Valid-format but non-existent coupon → 404
  {
    const { status } = await call("PATCH", "/coupons/000000000000000000000000/redeem", { headers: userHeaders() });
    if (status === 404) log("redeem non-existent coupon → 404", "PASS");
    else log("redeem non-existent coupon → 404", "FAIL", `status=${status}`);
  }
}

async function testLogs() {
  section("Logs  POST /logs (public) · GET /logs (admin)");

  // POST missing required fields → 400
  {
    const { status } = await call("POST", "/logs", { body: { event: "app_open" } });
    if (status === 400) log("POST logs missing fields → 400", "PASS");
    else log("POST logs missing fields → 400", "FAIL", `status=${status}`);
  }

  // POST valid → 201 (public, no auth)
  {
    const { status, data } = await call("POST", "/logs", {
      body: {
        event: "app_open",
        deviceId: `test-device-${Date.now()}`,
        platform: "ios",
        appVersion: "1.0.0",
        buildNumber: "42",
        level: "info",
        route: "/home",
      },
    });
    if (status === 201 && data.ok) log("POST logs valid → 201", "PASS");
    else log("POST logs valid → 201", "FAIL", `status=${status}`);
  }

  // GET logs no auth → 401
  {
    const { status } = await call("GET", "/logs");
    if (status === 401) log("GET logs no auth → 401", "PASS");
    else log("GET logs no auth → 401", "FAIL", `status=${status}`);
  }

  // GET logs as admin → 200 with logs array + total
  {
    const { status, data } = await call("GET", "/logs", { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.logs) && typeof data.total === "number") {
      log("GET logs (admin) → 200", "PASS", `total=${data.total}`);
    } else {
      log("GET logs (admin) → 200", "FAIL", `status=${status}`);
    }
  }

  // GET logs with filters (admin) → 200
  {
    const { status, data } = await call("GET", "/logs?event=app_open&level=info", { headers: adminHeaders() });
    if (status === 200 && Array.isArray(data.logs)) {
      log("GET logs filtered (admin) → 200", "PASS", `count=${data.logs.length}`);
    } else {
      log("GET logs filtered (admin) → 200", "FAIL", `status=${status}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}MintRewards API Test Runner${RESET}`);
console.log(`${DIM}Target: ${BASE}${RESET}`);

try {
  await authenticateAdmin();
  await registerBrandUser();
  await registerAppUser();
  await testRegistration();
  await testBrandRetrieval();
  await testBrandAdmin();
  await testBrandSettings();
  await testAnalytics();
  await testCampaigns();
  await testDeals();
  await testAdminViews();

  // ── Additional endpoint coverage ──
  await testAdminLoginNegative();
  await testUserSignup();
  await testUserLogin();
  await testPasswordReset();
  await testUserProfile();
  await testUserDiscounts();
  await testReferrals();
  await testActiveCampaigns();
  await testDeleteAccount();
  await testSocialAuth();
  await testBrandhubAuth();
  await testBrandhubBrands();
  await testBrandhubModules();
  await testCoupons();
  await testLogs();
} catch (err) {
  console.error(`\n${RED}${BOLD}Unexpected error — test run aborted${RESET}`);
  console.error(err);
  process.exit(1);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const total = passed + failed + skipped;
console.log(`\n${"─".repeat(56)}`);
console.log(
  `${BOLD}Results:${RESET}  ` +
  `${GREEN}${passed} passed${RESET}  ` +
  `${RED}${failed} failed${RESET}  ` +
  `${YELLOW}${skipped} skipped${RESET}  ` +
  `${DIM}(${total} total)${RESET}`,
);

if (failed > 0) process.exit(1);
