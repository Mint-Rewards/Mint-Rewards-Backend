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

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}MintRewards API Test Runner${RESET}`);
console.log(`${DIM}Target: ${BASE}${RESET}`);

try {
  await authenticateAdmin();
  await registerBrandUser();
  await testRegistration();
  await testBrandRetrieval();
  await testBrandAdmin();
  await testBrandSettings();
  await testAnalytics();
  await testCampaigns();
  await testDeals();
  await testAdminViews();
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
