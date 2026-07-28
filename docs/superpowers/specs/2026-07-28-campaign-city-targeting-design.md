# Campaign City Targeting — Design

## Problem

Campaigns currently have no location targeting. Brands need to peg a campaign
to specific cities so it's only surfaced to users in those cities. Users
already have a `city` field (set via profile completion) that isn't used for
any filtering today.

## Cities

Fixed list, single source of truth in `lib/cities.ts`:

```
Karachi, Lahore, Islamabad, Faisalabad, Rawalpindi, Multan, Hyderabad
```

## Data model

Add `cities?: string[]` to `Campaign` (`lib/types.ts`) and `CampaignSchema`
(`lib/models.ts`):

- `enum: TARGETABLE_CITIES`
- `default: []`
- Empty array (or field absent) = **untargeted** = visible to all users,
  including users with no city set.

This is additive and independent of the existing unused `addresses` field
(free-form province/city/town shape) — `addresses` is out of scope and
untouched.

## Visibility rule

New helper `lib/campaignVisibility.ts`:

```ts
export function isCampaignVisibleToCity(
  campaign: { cities?: string[] },
  userCity?: string | null,
): boolean {
  if (!campaign.cities || campaign.cities.length === 0) return true;
  if (!userCity) return false;
  return campaign.cities.includes(userCity);
}
```

Truth table:

| Campaign cities | User city    | Visible? |
|------------------|-------------|----------|
| `[]`             | any / none  | yes      |
| `["Lahore"]`     | `"Lahore"`  | yes      |
| `["Lahore"]`     | `"Karachi"` | no       |
| `["Lahore"]`     | none set    | no       |

## Creation

`app/api/brands/[id]/campaigns` (POST) and
`app/api/brandhub/brands/[brandId]/campaigns` (POST):

- Accept `cities` in the request body.
  - JSON body: array of strings.
  - multipart/form-data body (used when a banner file is attached): a
    comma-separated string, split and trimmed.
- Validate every value against `TARGETABLE_CITIES` (case-sensitive exact
  match against the fixed list). Trim whitespace, dedupe. If any value is
  not in the list, respond `400` naming the invalid value(s) — nothing is
  created.
- Omitted/empty `cities` → campaign created untargeted (`cities: []`).

## Editing

`app/api/brands/[id]/campaigns/[campaignId]` (PATCH) and
`app/api/brandhub/brands/[brandId]/campaigns/[campaignId]` (PATCH):

- Add `"cities"` to the `BRAND_EDITABLE` set.
- Same parsing/validation as creation before `$set`.

## Filtering on read

Apply `isCampaignVisibleToCity` in the three user-facing read paths, using
the requesting user's `city` (fetched via
`UserModel.findById(userId).select("city").lean()`):

- `GET /api/users/active-campaigns` — filter `activeCampaigns`.
- `GET /api/users/my-discounts` — filter the `discounts` list.
- `GET /api/brands` — filter each brand's nested `campaigns` array, **only
  on the non-admin branch**; the admin branch stays unfiltered (admins see
  everything, as today).

No other routes change: admin campaign listing
(`app/api/brands/campaigns`), brand-owned campaign listing (both
`GET .../campaigns`), analytics, and coupon redemption are brand/admin- or
already-committed-discount paths, not city-gated discovery surfaces.

## Testing

- Unit tests for `isCampaignVisibleToCity` covering the truth table above.
- Route tests: creation rejects an invalid city, accepts a valid subset,
  defaults to `[]` when omitted.
- Route test: `active-campaigns` (or equivalent) hides a city-targeted
  campaign from a user in a different city, and from a user with no city
  set, while still returning an untargeted campaign to both.

## Out of scope

- No change to the `addresses` field.
- No UI/dropdown work (backend only, per request).
- No backfill needed — existing campaigns have no `cities` field, which
  reads as `[]` (untargeted) under the schema default.
