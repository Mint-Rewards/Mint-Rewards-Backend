/**
 * API response baseline: normalization, recording and comparison.
 *
 * WHY THIS EXISTS
 * The mobile app only talks to this backend over HTTP, so the real acceptance
 * test for the Mongo -> Postgres migration is not "do the row counts match" but
 * "does the same request return the same response". This module captures a
 * golden baseline from the current Mongoose-backed backend so a future
 * Postgres-backed one can be diffed against it.
 *
 * Plain CommonJS, like this repo's other scripts, so both scripts/test-api.mjs
 * (ESM) and the jest suite (ts-jest) can load it.
 *
 * ---------------------------------------------------------------------------
 * THE NORMALIZATION RULES — the load-bearing part of this file.
 *
 * A raw response can never be compared across two different databases: ids,
 * tokens and timestamps differ every run and between implementations. But
 * blanking everything volatile throws away exactly the information a migration
 * is most likely to get wrong. Each rule below is therefore a deliberate
 * trade-off, not a convenience.
 *
 * 1. IDENTIFIERS -> STABLE SYMBOLS, NOT BLANKS.
 *    A Mongo ObjectId ("6a5e...") becomes a Postgres integer (42). They can
 *    never compare equal, so a naive diff is useless and blanking them to
 *    "<id>" would hide the single most important class of migration bug:
 *    a reference pointing at the WRONG row.
 *    Instead every distinct id value is replaced by "<id:N>", numbered in
 *    order of first appearance across the whole capture. That preserves
 *    REFERENTIAL STRUCTURE while discarding the representation: if a deal's
 *    brandId is the same value as some brand's id in the Mongoose run, it must
 *    still be the same symbol in the Postgres run. Un-remapped-ObjectId bugs,
 *    off-by-one id maps and cross-linked rows all show up as a symbol
 *    mismatch. This is the main reason to normalize rather than blank.
 *
 * 2. SECRETS AND TOKENS -> "<token>".
 *    JWTs embed an issued-at claim, so they differ on every run even against
 *    one unchanged database. Nothing about their value is comparable; only
 *    their PRESENCE is, which the placeholder preserves.
 *
 * 3. SERVER-STAMPED TIMESTAMPS -> "<timestamp>", DOMAIN DATES KEPT.
 *    `createdAt`/`updatedAt`/`created`/`expiresAt` are wall-clock artifacts of
 *    when the test ran. But `startDate`/`endDate` on a campaign or deal are
 *    DATA — a migration that mangles them (and this schema carries every one
 *    of them as `text`, a known piece of type debt) must fail the diff. So the
 *    two are separated by name, via SERVER_STAMPED_DATE_FIELDS below, rather
 *    than by a blanket "looks like a date" regex.
 *
 * 4. TEST-RUN-GENERATED IDENTITY -> "<generated>".
 *    test-api.mjs mints accounts with a `Date.now() + uuid` suffix, so emails,
 *    mintIds and registration numbers differ every run by construction. The
 *    suffix is stripped rather than the whole value, so a real change to the
 *    STABLE part of the value still shows up.
 *
 * 5. ARRAY ORDER IS PRESERVED, NEVER SORTED.
 *    Sorting would make diffs quieter and is the obvious temptation. It is
 *    also wrong here: Mongo natural order and Postgres unordered-SELECT order
 *    genuinely differ, and the app renders some of these lists directly. An
 *    order change IS a parity finding the reviewer must see and rule on, not
 *    noise to suppress. If a given endpoint's order is legitimately
 *    unspecified, record that as a decision — do not fix it by sorting here.
 *
 * KNOWN EXPECTED DIFF, do not "fix" by normalizing it away: Mongoose stamps
 *    `__v` on every document and it surfaces in responses that return raw
 *    documents. A Postgres-backed backend will not emit it, so it will appear
 *    as a diff on many endpoints in the first comparison. That is a real API
 *    shape change and a deliberate decision for whoever does the rewrite
 *    (keep emitting it for compatibility, or drop it and confirm no client
 *    reads it) — which is precisely why it is surfaced rather than stripped.
 *
 * 6. ABSENT IS NOT NULL IS NOT EMPTY.
 *    Key order is normalized (sorted) so formatting churn does not register,
 *    but a missing key, an explicit null and "" stay distinct. The ETL has
 *    already produced one real bug in exactly this seam (explicit null vs
 *    absent, defeating a NOT NULL DEFAULT), so collapsing them would blind the
 *    diff to its recurrence at the API layer.
 */

"use strict";

// ---------------------------------------------------------------------------
// Field classification. These lists are the reviewable surface of rule 1-4 —
// edit them deliberately, and prefer adding a name here over loosening a
// regex, so every exception stays visible and greppable.

/** Keys whose VALUE is an identifier that must become a stable symbol. */
const ID_FIELDS = new Set([
  "_id",
  "id",
  "userId",
  "brandId",
  "campaignId",
  "dealId",
  "couponId",
  "orgId",
  "collectionId",
  "captain",
  "brand",
  "user",
  "organization",
  "legacyBrandId",
  "brandUserId",
  "logId",
  // mintId is a per-signup generated identifier: its literal value differs on
  // every run, so comparing it would be pure noise, but it must stay CONSISTENT
  // for one user across responses. That is exactly what a symbol gives.
  "mintId",
]);

/** Keys that carry a secret. Never comparable; presence is what matters. */
const TOKEN_FIELDS = new Set([
  "token",
  "accessToken",
  "refreshToken",
  "jwt",
  "authorization",
  "password",
  "otp",
  "otpHash",
  "verificationToken",
  "secret",
  // Password CONFIRMATION fields carry the same plaintext as `password`.
  // Found by recording a real signup: `confirmPassword` came through in the
  // clear while `password` was redacted. Baselines are files people commit and
  // share, so every alias has to be listed here, not just the obvious one.
  "confirmPassword",
  "newPassword",
  "oldPassword",
  "currentPassword",
  // Found by scanning a real capture: these carried only junk in that run, but
  // a genuine password-reset token need not be JWT-shaped (so the JWT regex
  // would miss it), and a genuine Google/Apple token is a live credential.
  // Redact by name rather than relying on the value's shape.
  "resetToken",
  "idToken",
  "identityToken",
]);

/**
 * Dates stamped by the server as a side effect of WHEN the test ran. Distinct
 * from domain dates (startDate/endDate/date), which are data and are compared.
 */
const SERVER_STAMPED_DATE_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "created",
  "expiresAt",
  "lastSentAt",
  "checkedAt",
  "capturedAt",
  "snapshotAt",
  "timestamp",
  "issuedAt",
  "profileBonusGrantedAt",
  "profileBonusWindowStartedAt",
  "locationCompletedAt",
]);

/** Keys whose value embeds the per-run unique suffix minted by test-api.mjs. */
const GENERATED_IDENTITY_FIELDS = new Set([
  "email",
  // NOTE: mintId is deliberately NOT here — it is an ID_FIELD (see above), so
  // rule 1 owns it, not rule 4.
  "registrationNumber",
  "userName",
  "companyName",
  "brandName",
  "domain",
  "name",
]);

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const JWT_RE = /^(Bearer\s+)?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// The suffix test-api.mjs appends: `${Date.now()}${randomUUID().slice(0,8)}`.
// 13 digits followed by 8 hex characters.
const RUN_SUFFIX_RE = /\d{13}[0-9a-f]{8}/gi;
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Allocates stable "<id:N>" symbols. One instance per capture, so numbering is
 * consistent across every response in the run — which is what makes
 * cross-response referential integrity checkable (rule 1).
 */
function createSymbolTable() {
  const map = new Map();
  return {
    symbolFor(value) {
      const key = String(value);
      if (!map.has(key)) map.set(key, `<id:${map.size + 1}>`);
      return map.get(key);
    },
    /** Exposed so a diff can report WHICH concrete value a symbol stood for. */
    entries() {
      return Object.fromEntries(map);
    },
    size() {
      return map.size;
    },
  };
}

function looksLikeIdentifier(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0;
  if (typeof value !== "string") return false;
  // A Mongo ObjectId, or a Postgres integer id arriving as a string.
  return OBJECT_ID_RE.test(value) || /^\d+$/.test(value);
}

function stripRunSuffix(value) {
  if (typeof value !== "string") return value;
  const stripped = value.replace(RUN_SUFFIX_RE, "<generated>");
  return stripped;
}

/**
 * Normalizes one response payload.
 *
 * @param {unknown} value      the parsed JSON body (or any nested part of it)
 * @param {object}  symbols    a table from createSymbolTable(), shared across the capture
 * @param {string}  keyName    the key this value was found under, "" at the root
 */
function normalizeValue(value, symbols, keyName = "") {
  if (value === null) return null;
  if (Array.isArray(value)) {
    // Rule 5: order preserved deliberately.
    return value.map((v) => normalizeValue(v, symbols, keyName));
  }
  if (typeof value === "object") {
    // Rule 6: keys sorted so formatting churn is not a diff, but presence is.
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = normalizeValue(value[k], symbols, k);
    }
    return out;
  }

  // ---- scalars ----
  if (TOKEN_FIELDS.has(keyName)) return value === null ? null : "<token>";
  if (SERVER_STAMPED_DATE_FIELDS.has(keyName)) return "<timestamp>";
  if (ID_FIELDS.has(keyName) && looksLikeIdentifier(value)) {
    return symbols.symbolFor(value);
  }
  if (typeof value === "string") {
    // A bare JWT in an unexpected field is still a secret.
    if (JWT_RE.test(value) && value.length > 40) return "<token>";
    // An ObjectId in a field not on the list is still an identifier — this is
    // the safety net for response keys nobody enumerated.
    if (OBJECT_ID_RE.test(value)) return symbols.symbolFor(value);
    if (ISO_DATE_RE.test(value) && SERVER_STAMPED_DATE_FIELDS.has(keyName)) {
      return "<timestamp>";
    }
    if (GENERATED_IDENTITY_FIELDS.has(keyName)) return stripRunSuffix(value);
    // Any value still carrying the per-run suffix is run-generated wherever it
    // appears (e.g. echoed back inside a message string).
    if (RUN_SUFFIX_RE.test(value)) {
      RUN_SUFFIX_RE.lastIndex = 0;
      return stripRunSuffix(value);
    }
    RUN_SUFFIX_RE.lastIndex = 0;
  }
  return value;
}

/**
 * Normalizes a whole capture: an ordered list of
 * { method, path, requestBody, status, data } interactions.
 * The symbol table is shared across all of them (rule 1).
 */
function normalizeCapture(interactions) {
  const symbols = createSymbolTable();
  const normalized = interactions.map((it) => ({
    method: it.method,
    // Ids embedded in the URL must be symbolized too, or every path with an
    // :id segment diffs on every run.
    path: normalizePath(it.path, symbols),
    requestBody:
      it.requestBody === undefined
        ? undefined
        : normalizeValue(it.requestBody, symbols),
    status: it.status,
    data: normalizeValue(it.data, symbols),
  }));
  return { interactions: normalized, symbols: symbols.entries() };
}

function normalizePath(path, symbols) {
  return String(path)
    .split("/")
    .map((seg) => {
      const [bare, ...rest] = seg.split("?");
      if (OBJECT_ID_RE.test(bare) || /^\d+$/.test(bare)) {
        const sym = symbols.symbolFor(bare);
        return rest.length ? `${sym}?${rest.join("?")}` : sym;
      }
      return seg;
    })
    .join("/");
}

// ---------------------------------------------------------------------------
// Comparison

/** Recursively collects "path -> [baselineValue, currentValue]" differences. */
function diffValue(a, b, path, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const aIsObj = a && typeof a === "object" && !Array.isArray(a);
  const bIsObj = b && typeof b === "object" && !Array.isArray(b);
  if (aIsObj && bIsObj) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const inA = Object.prototype.hasOwnProperty.call(a, k);
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      if (!inA)
        out.push({ path: `${path}.${k}`, baseline: "<absent>", current: b[k] });
      else if (!inB)
        out.push({ path: `${path}.${k}`, baseline: a[k], current: "<absent>" });
      else diffValue(a[k], b[k], `${path}.${k}`, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({
        path: `${path}.length`,
        baseline: a.length,
        current: b.length,
      });
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length)
        out.push({
          path: `${path}[${i}]`,
          baseline: "<absent>",
          current: b[i],
        });
      else if (i >= b.length)
        out.push({
          path: `${path}[${i}]`,
          baseline: a[i],
          current: "<absent>",
        });
      else diffValue(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }
  out.push({ path, baseline: a, current: b });
}

/**
 * Compares two normalized captures, matching interactions by position AND by
 * (method, path) so a missing or extra request is reported as such rather than
 * silently shifting every subsequent comparison.
 */
function compareCaptures(baseline, current) {
  const results = [];
  const n = Math.max(baseline.interactions.length, current.interactions.length);
  for (let i = 0; i < n; i++) {
    const a = baseline.interactions[i];
    const b = current.interactions[i];
    if (!a) {
      results.push({
        index: i,
        label: `${b.method} ${b.path}`,
        kind: "extra",
        diffs: [],
      });
      continue;
    }
    if (!b) {
      results.push({
        index: i,
        label: `${a.method} ${a.path}`,
        kind: "missing",
        diffs: [],
      });
      continue;
    }
    const label = `${a.method} ${a.path}`;
    if (a.method !== b.method || a.path !== b.path) {
      results.push({
        index: i,
        label,
        kind: "desynced",
        diffs: [
          {
            path: "request",
            baseline: label,
            current: `${b.method} ${b.path}`,
          },
        ],
      });
      continue;
    }
    const diffs = [];
    if (a.status !== b.status) {
      diffs.push({ path: "status", baseline: a.status, current: b.status });
    }
    diffValue(a.data, b.data, "data", diffs);
    results.push({
      index: i,
      label,
      kind: diffs.length ? "differs" : "match",
      diffs,
    });
  }
  return results;
}

function summarize(results) {
  const counts = { match: 0, differs: 0, missing: 0, extra: 0, desynced: 0 };
  for (const r of results) counts[r.kind]++;
  return counts;
}

module.exports = {
  ID_FIELDS,
  TOKEN_FIELDS,
  SERVER_STAMPED_DATE_FIELDS,
  GENERATED_IDENTITY_FIELDS,
  createSymbolTable,
  normalizeValue,
  normalizeCapture,
  normalizePath,
  compareCaptures,
  diffValue,
  summarize,
};
