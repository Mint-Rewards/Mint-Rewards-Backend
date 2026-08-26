# P1 Backend Services — Location Capture

Spec authority: the master location-capture plan (conversation doc, §P1). This file is the
executable breakdown. Repo: `Mint-Rewards-Backend`, branch `feature/location-capture-p0`.

## Global Constraints

- **Additive only.** Never edit or remove existing schema fields, env vars, or response
  fields. Legacy `latitude`/`longitude`/`address`/`city`/`town`/`townOther`/`subArea`/
  `subAreaOther` stay and are dual-written.
- **No geocoder key ever reaches the client.** LocationIQ is called server-side only.
- **Geocoding is never blocking.** Timeouts, quota exhaustion, missing API key → HTTP 200
  `{ resolved: false }`, never a 5xx. Onboarding must complete during a LocationIQ outage.
- **Never write NaN or empty coordinate arrays** into any GeoJSON field (P0.3 discipline).
- **Persistence tests read back through the raw Mongo driver**, never the endpoint echo
  (see `__tests__/updateProfileLocation.test.ts` for the pattern and the reason).
- Tests run against `MONGODB_URI_TEST` via `jest.setup.js`. `npx tsc --noEmit` stays clean.
- Follow existing route conventions: Next App Router `route.ts` files (NOT the Express
  layer — see the comment at the top of `app/api/app-config/route.ts`), auth via
  `getAuthenticatedUserId` from `@/lib/auth`, rate limiting via `checkRateLimit` from
  `@/lib/rateLimit`, env via the helper patterns in `lib/env.ts`.
- Commit messages end with the project's Claude trailer (see `git log`).

---

## Task 1 — Location registry artifact + backend registry module

The backend has zero registry knowledge; the canonical registry lives in the app repo at
`/Users/ifrahchishti/Developer/Mint-Rewards-App/utils/pakistan_areas.ts` (metadata) and
`utils/pakistan_locations.ts` / `PAKISTAN_LOCATIONS` (raw data). Source of truth stays in
the app repo; the backend consumes a committed JSON export (the PC-2 pattern: staleness is
visible, divergence fails CI).

**1a. Generator (app repo).** Add `scripts/export_location_registry.ts` to the app repo
with a package.json script `"export:registry": "npx tsx scripts/export_location_registry.ts"`.
It imports from `utils/pakistan_areas.ts` and writes JSON to stdout or a `--out` path:

```jsonc
{
  "version": 1,
  "cities": {
    "Karachi": {
      "province": "Sindh",
      "tier": "A", // from getCoverageTier(city)
      "hasTowns": true, // cityHasTowns(city)
      "towns": ["..."], // getTownsForCity — ALL stored towns
      "selectableTowns": ["..."], // getSelectableTownsForCity
      "deprecatedTowns": ["..."], // DEPRECATED_TOWNS[city] ?? []
      "aliases": { "Shanti Nagar": "Gulshan-e-Iqbal" }, // from AREA_META[`${city}::${town}`].aliases, inverted alias→town
    },
  },
}
```

No timestamp field — the artifact must be byte-stable so regeneration with no registry
change produces no diff. Run it, commit the generator to the app repo (its own commit, on
the app repo's current branch), and commit the output to the backend as
`lib/data/locationRegistry.json`.

**1b. Backend module `lib/locationRegistry.ts`:**

- `getProvinceForCity(city): string | null`
- `getCoverageTier(city): "A" | "B" | "C"` — default `"C"` for unknown cities
- `cityHasTowns(city): boolean` — default false
- `foldName(value): string` — port VERBATIM from the app repo's `foldName`
  (`utils/pakistan_areas.ts:103`), with a test asserting identical behavior on at least
  5 pairs copied from the app repo's own tests
- `resolveGeocodedName(raw, city?): { city: string; town: string } | null` — resolution
  order exact → fold → alias → fail, mirroring the app's semantics:
  - a name matching a **deprecated** town resolves to `null` (deprecated candidates are
    dropped BEFORE ambiguity is judged — a deprecated town's own name must not tie with
    a live parent's alias and poison the match; this exact bug existed in the app repo)
  - a raw name matching two **live** towns (in scope) is ambiguous → `null`
  - with `city` given, search only that city; without it, search all cities
- All accessors return safe defaults on unknown keys; none throws.

**Tests (`__tests__/locationRegistry.test.ts`):** artifact parses and contains Karachi
with tier "A" and >70 towns; foldName parity pairs; resolveGeocodedName: exact hit, fold
hit (case/diacritic variant), alias hit (use a real alias from the artifact, e.g.
`"Shanti Nagar"` → Gulshan-e-Iqbal), deprecated → null, unknown → null, cross-city
ambiguity → null when unscoped. Read the real committed artifact, no fixtures.

---

## Task 2 — Gate configuration on /api/app-config (P1.3)

Extend `lib/env.ts` `serverEnv.appConfig` (additive) and the `/api/app-config` response
with a `locationGate` object. Use the existing optional-helper patterns in `lib/env.ts`.

| Env var                               | Type                   | Default      |
| ------------------------------------- | ---------------------- | ------------ |
| `LOCATION_GATE_MODE`                  | enum `hard\|soft\|off` | `"soft"`     |
| `LOCATION_GATE_ACTIVATED_CITIES_ONLY` | boolean                | `false`      |
| `LOCATION_GATE_MAX_DISMISSALS`        | positive int           | `3`          |
| `LOCATION_GATE_MIN_BUILD_IOS`         | optional build number  | unset → null |
| `LOCATION_GATE_MIN_BUILD_ANDROID`     | optional build number  | unset → null |

Response addition (existing fields UNCHANGED):

```jsonc
"locationGate": {
  "mode": "soft",
  "activatedCitiesOnly": false,
  "maxDismissals": 3,
  "minClientBuild": { "ios": null, "android": null }
}
```

An invalid `LOCATION_GATE_MODE` value fails fast at startup like other env problems
(push to `problems`), it does NOT silently default. Document each var in `.env.example`
(mirror existing style; note `soft` must be the deployed default until 2.1.10 store
adoption justifies `hard`). The gate resolution order (build < minClientBuild → soft,
etc.) is CLIENT logic — the server only serves the values; say so in a comment.

**Tests:** extend the app-config test if one exists, else add
`__tests__/appConfigLocationGate.test.ts`: defaults appear when env unset; values flow
through when set; existing five fields still present.

---

## Task 3 — evaluateLocation (P1.2)

New `lib/evaluateLocation.ts`. Server-side single source of completion truth; the client
contains no completion logic.

```ts
export const LOCATION_COMPLETION_VERSION = 1;

export interface LocationEvaluation {
  complete: boolean;
  missing: string[]; // subset of ["cityId","areaId","houseNo","pin"]
  version: number; // LOCATION_COMPLETION_VERSION
  currentVersion: number; // user.locationVersion ?? 0
  bucket: "complete" | "has_pin_partial" | "no_pin";
}

export function evaluateLocation(user): LocationEvaluation;
```

Field satisfaction (escape hatches count — a hard gate must never demand a value the
registry cannot offer):

- `cityId`: `structuredAddress.cityId` non-empty, else legacy `city` non-empty
- `areaId`: `structuredAddress.areaId` OR `structuredAddress.areaOther` non-empty, else
  legacy `town` OR `townOther` non-empty
- `houseNo`: `structuredAddress.houseNo` non-empty
- `pin`: `location.coordinates` is a 2-length finite array AND `location.source` is
  `"map_pin"` or `"collector_verified"`

Requirement set by tier of the resolved city (via Task 1's registry module):

- Tier A/B **and** `cityHasTowns(city)`: `["cityId","areaId","houseNo"]`
- Tier C, or a city without towns (no registry to select from): `["cityId","houseNo","pin"]`
- No city at all: requirements are the tier-C set (missing starts at `cityId`)

`complete` = every required field satisfied. `bucket`: `"complete"` when complete;
otherwise `"has_pin_partial"` if the pin test passes, else `"no_pin"`.

**Tests (`__tests__/evaluateLocation.test.ts`)**, pure unit, no DB: complete tier-A user;
tier-A missing houseNo; legacy-only user (city/town strings, no structuredAddress) with
houseNo missing → areaId satisfied by legacy town; townOther satisfies areaId; tier-C /
unknown city requires pin and not areaId; pin with `area_centroid` source does NOT
satisfy pin; empty coordinates array does not satisfy pin; currentVersion echoes
locationVersion.

---

## Task 4 — Progressive save endpoint (P1.4)

New route `app/api/users/location/route.ts`, method `PATCH` (repo convention is
`/api/users/...` — the master plan's `/api/user/location` is normalized to
`/api/users/location`). Auth: `getAuthenticatedUserId`; 401 on failure (match
update-profile's error shape).

Body: any subset of

```jsonc
{
  "structuredAddress": { "cityId": "...", "areaId": "...", "blockId": "...",
                          "areaOther": "...", "blockOther": "...",
                          "houseNo": "...", "streetOrBlock": "..." },
  "location": { "coordinates": [lng, lat], "source": "map_pin",
                 "precision": "building", "accuracyMeters": 8 }
}
```

Rules:

- **Dotted `$set` paths per provided leaf only** — never assign a whole subdocument
  (partial update must not wipe sibling keys; this is the two-allowlist / P0.3 lesson).
- Validate: strings trimmed, ≤ 200 chars; `source`/`precision` against the schema enums;
  `coordinates` a 2-length array of finite numbers with lng ∈ [-180,180], lat ∈ [-90,90].
  Invalid input → 400 with a message; unknown keys ignored.
- Writing `location.coordinates` also sets `location.type = "Point"` and
  `location.capturedAt = new Date()`.
- **Dual-write legacy fields** in the same `$set`:
  - `cityId` → `city`, and `province` via `getProvinceForCity` (skip province when null)
  - `areaId` → `town` and `townOther: ""`; `areaOther` → `townOther` and `town: ""`
  - `blockId` → `subArea` and `subAreaOther: ""`; `blockOther` → `subAreaOther` and `subArea: ""`
  - `coordinates` → legacy `latitude`/`longitude` strings (lat/lng human order)
- After the update, load the user and run `evaluateLocation`. If `complete` and
  `locationVersion < LOCATION_COMPLETION_VERSION`: one more update setting
  `locationVersion = LOCATION_COMPLETION_VERSION`, `locationCompletedAt = new Date()`.
- Response 200: `{ "Status": "Success", "evaluation": <LocationEvaluation> }`.

**Tests (`__tests__/usersLocationPatch.test.ts`)**, DB-backed, raw-driver reads, mocking
auth like `updateProfileLocation.test.ts`: partial save of cityId alone persists and does
not touch other structuredAddress keys; second PATCH with areaId keeps cityId (sibling
preservation); dual-writes land (city, province, town, latitude/longitude strings); bad
coordinates → 400 and nothing written; completing payload sets
locationVersion/locationCompletedAt exactly once (repeat PATCH does not bump
locationCompletedAt); response carries the evaluation with `complete: true`.

---

## Task 5 — Reverse-geocode service + permanent cache (P1.1)

New route `app/api/location/reverse-geocode/route.ts`, method `POST`. Auth required.
Rate limit: `checkRateLimit("reverse-geocode", userId, 20, 3_600_000)` → 429 when
exceeded.

- Env (additive, `lib/env.ts` + `.env.example`): `LOCATIONIQ_API_KEY` (optional string,
  null when unset). Unset key → every call returns `{ resolved: false }` without
  fetching or caching. The key never appears in any response.
- Body `{ lat, lng }`: finite numbers, lat ∈ [-90,90], lng ∈ [-180,180]; else 400.
- **Cache**: new model `GeocodeCacheModel` (collection `geocodeCache`), `_id` =
  `"${lat3},${lng3}"` where lat3/lng3 are `toFixed(3)` of the inputs (~100 m).
  Document: `{ _id, raw, cityName, areaName, blockHint, resolvedAt: Date }`. PERMANENT —
  no TTL index (load-bearing: the cache is what keeps live volume inside the free tier,
  and `geocodedAreaRaw` + the future gazetteer depend on it). Cache hit → serve without
  fetching. Only successful LocationIQ responses are cached; failures/timeouts never are.
- **Fetch**: `https://us1.locationiq.com/v1/reverse?key=<k>&lat=<lat>&lon=<lng>&format=json&addressdetails=1&zoom=16`
  with `AbortSignal.timeout(3000)`. Any fetch error, non-200, or timeout → 200
  `{ resolved: false }`. Never a 5xx from this route.
- **Resolution** (Task 1 module): `cityName` = first of `address.city`, `address.town`,
  `address.municipality`. Area: try `address.suburb`, `address.city_district`,
  `address.neighbourhood` IN ORDER through `resolveGeocodedName(raw, cityName)` until one
  resolves (the response is inconsistent about which key carries the locality).
  `blockHint` = `address.neighbourhood ?? address.residential ?? null` (raw string, a
  hint only — NEVER written to any canonical field). `unmatched` = the tried locality
  strings that failed resolution. Log each unmatched value via `console.warn` with a
  stable prefix `[geocode-unmatched]` — this is the alias backlog feed.
- Response 200: `{ resolved: boolean, cityName, areaName, blockHint, raw, unmatched }`
  where `resolved` = areaName non-null. `raw` is LocationIQ's `address` object (from
  cache on hits).

**Tests (`__tests__/reverseGeocode.test.ts`)**: mock `global.fetch` (never hit the real
API). Cases: happy path resolves suburb → registry town, response shape correct, cache
document written (raw-driver read of `geocodeCache`); second identical call serves from
cache with `fetch` called zero times; fetch rejection → `{ resolved: false }`, nothing
cached; missing API key → `{ resolved: false }`, fetch not called; out-of-range coords →
400; suburb unmatched but city_district resolving → resolved with `unmatched` containing
the suburb; rate limit path → 429 (mock or drive `checkRateLimit`).
