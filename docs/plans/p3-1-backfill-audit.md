# P3.1 Backfill Audit Script (read-only)

Spec authority: master location-capture plan §P3.1, plus open items P0.5 and P0.4b.
Repo: `Mint-Rewards-Backend`, branch `feature/location-capture-p0`. One task.

## Global Constraints

- **Read-only, absolutely.** The script performs no write of any kind to any database.
  No geocoding calls either — bucketing is centroid-distance only (settled ruling:
  geocoder agreement would misfile correctly-addressed users).
- Standard gating from the repo's own precedent (`scripts/backfill-referral-reward-granted.js`):
  `--target=test|production` required, DB-name assertion after connect, summary counts
  printed before any detail.
- Resumable: checkpoint file + cursor so a production run can chunk across sessions.
- Deduplicate on coordinates rounded to 3 decimals before any per-coordinate work.
- Backend tests (235) and tsc stay green. App repo: touch ONLY
  `scripts/export_location_registry.ts`, `utils/__generated__/locationRegistry.json`,
  and `__tests__/exportLocationRegistry*.test.ts` (P2 subagents are editing other app
  files concurrently — do not touch components/, app/, utils/pakistan_areas.ts).

## Task 1 — the audit script

**1a. Artifact extension (app repo).** The audit needs two datasets the committed
registry artifact lacks:
- `deprecatedSubAreas`: export the app's `DEPRECATED_SUB_AREAS` per city (keyed
  `"City::Town"` → sorted string array).
- `areaCentroids`: export `AREA_CENTROIDS` and `CITY_CENTROIDS`. **These are currently
  empty objects in `utils/pakistan_areas.ts`** — search both repos for the spike
  by-product `centroids.json` (16 Karachi areas, mean coordinate + max sample radius).
  If found: ingest into `AREA_CENTROIDS`-shaped data WITHIN THE GENERATOR ONLY (do not
  edit pakistan_areas.ts — read the JSON from its found location, or copy it into
  `scripts/data/`). If not found anywhere: export the empty maps, add a `--centroids
  <path>` override flag to the audit script, and report the gap prominently.
Regenerate BOTH artifacts (app fixture + backend `lib/data/locationRegistry.json`),
keep byte-stable, keep the sync test green.

**1b. Script `scripts/location-backfill-audit.ts`** (backend; runnable via npx tsx or
compiled — match however existing backend scripts run; if all existing scripts are .js,
write .js with JSDoc types):

Per user (all users with any of: coordinates, town, subArea):
- Parse legacy `latitude`/`longitude` (skip GeoJSON-vs-string mismatch traps; prefer
  `location.coordinates` when present).
- Bucket, in priority order:
  1. `deprecated_sub_area` — `"${city}::${town}"` + subArea matches the deprecated set
  2. `unresolvable` — stated town absent from the registry for their city (use the
     artifact's towns + deprecatedTowns as valid-as-stored; a deprecated town is NOT
     unresolvable)
  3. `no_pin` — no usable coordinate
  4. `agree` / `disagree` — pin within / beyond the containment distance of their
     stated town's centroid. Threshold: centroid's max sample radius × 1.5, floor
     2 km (the master plan warns max radius is NOT a containment bound — record the
     chosen heuristic in the report header as provisional, overridable via
     `--threshold-km`). Users whose town has no centroid → bucket `no_centroid`
     (a sixth bucket this script adds; the plan's four assume centroid coverage that
     does not exist yet).
- Output: `audit-report.json` (per-user: id hash — NOT email —, bucket, distanceMeters,
  city, town) + a printed summary table (bucket × city counts).

**1c. Fold in the two owed counts** (same connection, same run):
- P0.5: aggregate count of users per deprecated sub-area entry (the sign-off evidence).
- P0.4b gate: `countDocuments({ "pickupHistory.0": { $exists: true } })` — prints the
  number that decides whether the migration exists.

**1d. Rehearse against the test DB** (`--target=test`): seed 6-8 synthetic users
covering every bucket in a jest test that runs the bucketing FUNCTIONS (exported pure
from the script) — the script entrypoint itself stays out of jest. Assert: language
discipline in the report header (the report must state that `disagree` ≠ wrong address
and is not a geocoder error rate — verbatim requirement from the master plan).

**Tests:** pure bucketing unit tests (every bucket, priority order, threshold edge,
deprecated-town-still-resolvable case); artifact-extension tests in the app repo.
