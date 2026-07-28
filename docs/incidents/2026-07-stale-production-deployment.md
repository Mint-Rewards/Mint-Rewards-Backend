# Incident: production served a ~3-month-stale deployment

**Status:** Open — root cause identified in the deployment pipeline, not the code
**Discovered:** 2026-07-28
**Discovered during:** dev/prod environment-separation work (unrelated task)
**Severity:** High — production ran code from before three months of merged
security and feature work, and CI/DAST results across that window are void.
**Affected:** `https://mint-rewards-backend.vercel.app` (production project)

---

## Summary

The production deployment stopped tracking `main` at some point between
**2026-04-16 and 2026-06-20**. Everything merged to `main` after that window —
roughly three months of work, including the admin authentication route and the
CORS hardening — was never live, despite `origin/main` containing all of it.

This was found by accident. Nobody reported it, and two separate symptoms had
already been misattributed to other causes before the deployment itself was
suspected.

---

## Timeline of discovery

1. **A 404 on `/api/admin/login`** was reported in production. The initial
   hypothesis was a routing problem — a route group, a `basePath`, or a
   middleware rewrite changing the deployed path.

2. **Routing was ruled out.** `next.config.js` was empty (`{}`), no
   `vercel.json` or `vercel.ts` existed, there were no route groups (`(x)`) or
   parallel routes (`@x`) anywhere under `app/`, and `middleware.ts` only
   called `NextResponse.next()` with no `rewrite()` or `redirect()`. The build
   manifest emitted `ƒ /api/admin/login` — exactly the source path.

3. **Method mismatch was ruled out.** Running the built app locally,
   `GET /api/admin/login` returned **405**, not 404. `POST` behaved correctly
   (400 on empty body, 401 on bad credentials). So the deployed 404 was not
   this route responding at all.

4. **Git lineage appeared to clear the code.** The commit adding the route
   (`41bcd70`, 2026-06-24) *is* an ancestor of `origin/main`, whose tip was
   `44f81ce` (2026-07-24). Local `main` was in sync with `origin/main`. On
   paper, the route should have been deployed.

5. **A discriminating test was run** against a route known to exist in
   production, to tell "deployment is stale" from "route-specific fault":

   ```
   curl -i https://mint-rewards-backend.vercel.app/api/users/login
   → HTTP/2 200  {"message":"Login API is alive"}
   ```

   **This 200 was initially read as an all-clear. That reading was wrong.**
   The chosen probe route's `GET` handler also existed in the April build, so a
   200 never distinguished a current deployment from an old one. The test was
   not actually discriminating.

6. **The response headers — not the status code — broke the case open.** The
   200 response carried CORS headers that the current `middleware.ts` cannot
   produce. This was spotted on review of the raw output, and is what turned a
   route-specific mystery into a deployment-wide finding.

---

## The proof: byte-for-byte header comparison

Live production response to `GET /api/users/login` on 2026-07-28:

```
HTTP/2 200
access-control-allow-origin:  *
access-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS
access-control-allow-headers: Content-Type, Authorization
x-matched-path: /api/users/login
x-vercel-id: bom1::iad1::qgtsp-1785228789626-5adbd7cb32e7
```

Two things are immediately impossible for the current code:

- **No `vary: origin`.** `middleware.ts` sets `Vary: Origin` on every response
  it touches, without exception.
- **`access-control-allow-methods` on a plain `GET`.** `middleware.ts` only
  emits that header on an `OPTIONS` preflight.
- **`access-control-allow-origin: *`.** `middleware.ts` never emits a wildcard;
  it reflects a specific allowlisted origin or emits nothing.

These headers match, byte for byte, the `async headers()` block in
`next.config.js` at commit **`a68e1e9` (2026-04-16, "transfer")**:

```js
{ key: "Access-Control-Allow-Origin",  value: "*" },
{ key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
{ key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
```

### The date bound

The decisive detail is the **absence of `PATCH`** from the live
`access-control-allow-methods` value.

| Date | Commit | Event |
|---|---|---|
| 2026-04-16 | `a68e1e9` | `headers()` block with `GET, POST, PUT, DELETE, OPTIONS` — **matches live response** |
| 2026-06-20 | `c13b0cb` | `PATCH` added to that list — **live response does not have this** |
| 2026-06-20 | `844e557` | `middleware.ts` introduced ("bulletproof CORS") — **live response shows no sign of it** |
| 2026-06-24 | `41bcd70` | `/api/admin/login` added — **404s in production** |
| 2026-07-04 | `bff3ae9` | `headers()` block deleted entirely; CORS moves fully to `middleware.ts` |
| 2026-07-24 | `44f81ce` | Current `origin/main` tip |

The live artifact contains the 2026-04-16 header list and neither the
2026-06-20 `PATCH` addition nor `middleware.ts`. **The deployed build is
therefore from between 2026-04-16 and 2026-06-20.**

This single cause explains both symptoms: the wildcard CORS *and* the
`/api/admin/login` 404 are the same stale artifact, not two independent faults.

---

## Confirmed NOT a contributing factor

Checked specifically to be sure nothing would keep emitting a wildcard after a
current build ships, so that `ALLOWED_ORIGINS` does not go live layered over a
permissive header:

| Candidate | Working tree | `origin/main` |
|---|---|---|
| `next.config.js` `headers()` | Empty `{}` | Empty `{}` |
| `vercel.json` / `vercel.ts` | Absent | Absent |
| Any other `Access-Control` emitter | Only `middleware.ts` | Only `middleware.ts` |

Vercel provides no dashboard-level header rules — headers are config-file only
— so there is no out-of-repo source either. **The wildcard exists solely inside
the stale artifact and disappears the moment any current build deploys.**

---

## Open action items

### 1. Restore production tracking of `main` — OWNER: unassigned

Root cause is in the Vercel project, not the repository. Determine which of
these it is:

- a failed production build, with the last successful (April/May) deployment
  still holding the alias;
- the `mint-rewards-backend.vercel.app` domain aliased to a different project
  or to a pinned deployment;
- the production branch setting no longer pointing at `main`.

Confirm resolution by hitting `GET /api/health` — a route that **does not exist
in the stale artifact at all**, so a 200 with an `environment` field is
unambiguous proof of a current build. It also reports the resolved database
name and commit SHA. Until that endpoint answers, treat production as unknown.

### 2. Re-verify the `ADMIN_PASSWORD_HASH` `$`-escaping bug — OWNER: unassigned

Separate, still-unconfirmed defect. Next's env loader performs `$`-expansion on
`.env` values, so a bcrypt hash must be written `\$2b\$10\$…`; `dotenv` (used by
Jest and the `scripts/` CLIs) does **not** unescape it. The same file therefore
yields different strings depending on the reader, and `bcrypt.compare` silently
returns `false` against the escaped form.

A normaliser has landed in `lib/env.ts` and is correct either way. What remains
unknown is whether the **production Vercel env var** is stored escaped.

**This could not have been producing a production symptom**, because the admin
route is not in the deployed artifact. It therefore cannot be diagnosed by
probing the live endpoint, and must be checked directly in the Vercel
dashboard — ideally **before** action item 1 promotes a current build, since
that is the moment the admin route becomes reachable for the first time.

Expected signature if it is live-broken: **401 "Invalid credentials" on correct
credentials** — not a 404.

---

## CI and DAST results from this window are not trustworthy

Both workflows targeted `https://mint-rewards-backend.vercel.app`, which has
been serving the stale artifact for the entire period:

- **`backend-ci.yml` smoke test** — curled `/api/health` with `--fail`. That
  path never existed as a deployed route (it was an Express-only router
  reachable solely from the Jest harness until this migration added a real
  one), so this step has been failing, or passing against something other than
  what it claims to check, for months.
- **`dast.yml` OWASP ZAP scan** — has been scanning the April build. **Every
  DAST result in this window describes code that is not `main`.** Any finding
  it reported may already be fixed; any vulnerability introduced after April was
  never scanned at all. Re-run once action item 1 is closed and treat prior
  results as void.

Both workflows have since been parameterised to target dev on `dev` and prod on
`main`, and the smoke test now asserts that the deployment reports the expected
`environment` — so a recurrence of this exact failure would be caught by CI
rather than found by accident.

---

## Lessons

- **A 200 is not proof of currency.** The probe route must be one that exists
  *only* in the new build. `/api/health` was chosen as the permanent probe for
  exactly this reason.
- **Response headers carry deployment identity that status codes do not.** The
  stale build was identified from a CORS header list, and dated to a
  three-week window by a single missing HTTP method.
- **Git lineage proves what *should* be deployed, never what *is*.** Every
  repository-side check passed while production ran three-month-old code.
