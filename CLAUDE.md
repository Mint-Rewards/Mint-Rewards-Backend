## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Domain vocabulary

`docs/VOCABULARY.md` is canonical for all three repos (backend, BrandHub, app).
Read it before naming a model, route, type, component or user-facing string.

In short: a **Campaign** is a recycling _programme_ ("what programme is this"),
a **Deal** is the consumer _incentive_ ("what do I get"), a **Discount** is one
_type_ of Deal (a price reduction), and a **coupon/promo code** is only the
redemption _mechanism_.

Two carryovers are deliberate and documented there: `CampaignModel` is
structurally a Discount-type Deal, and `/api/users/my-discounts` +
`/api/coupons/:couponId/redeem` both operate on **campaigns**. Both are
deprecated for the mobile client, and neither was renamed — the paths and
response keys are a published contract. New consumer-incentive work goes on
`Deal`.

## Deploying

### Write the command so a permission rule can match it

Allow rules match the **start of the command text**, after compound commands
are split at `&&`, `||`, `;`, `|` and `&`, and after the wrappers `timeout`,
`time`, `nice` and `nohup` are stripped. `npx` is **not** stripped, so a rule
has to name it. Every segment of a compound command must match, so one
unmatched segment denies the whole call.

| use | not |
| --- | --- |
| `npm run deploy` | `npx --yes vercel@59 --prod --yes` |
| `npx vercel deploy --prod --yes` | `npx --yes vercel@59 ...` |

The rule in user settings is `Bash(npx vercel:*)` — "starts with `npx vercel`".
`npx --yes vercel@59` starts with `npx --yes`, so it never matched, and the
classifier then evaluated it and refused with `[Production Deploy]`. That
looked for a long time like a category that could not be allow-listed. It was
not; it was the command being written in a shape no rule covered.

**An allow rule cannot match past an environment-variable assignment** (only
known-safe ones like `NODE_ENV` are skipped). So
`VERCEL_ORG_ID=... npx vercel --prod` is not expressible as an allow rule at
all. Put the variables inside an npm script if a command needs to be runnable
without a prompt.

### Which project is which

Dev and production are **separate Vercel projects**, not two environments of
one — the account is on the Hobby plan, which will not connect a private org
repo. `--prod` is Vercel's "not a preview" flag and says nothing about which.

| repo | dev project (the repo's `.vercel` link) | production project |
| --- | --- | --- |
| Mint-Rewards-Backend | `mint-rewards-backend-dev` | `mint-rewards-backend` |
| Mint-Rewards-Admin-API | `mint-rewards-admin-api` | `mint-rewards-admin-api-prod` |
| Mint-Rewards-BrandHub | `mint-rewards-brandhub` | `mint-rewards-brandhub-prod` |

Production admin API is `prj_TOZZJxsNzIyNTJGQoYERbuD9FfXb` in org
`team_c9TBpe25xW01GZU38CGH0YAH`, reached by overriding `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` so the repo's own link survives. Those are identifiers and
not credentials, but because of the assignment rule above that command cannot
be allow-listed — **ask the user to run production deploys** rather than
reshaping the command to get past a refusal.

### `scripts/deploy.sh` (admin API, and the backend's own copy)

- Stages the tree **without `.git`**, because Vercel attributes a CLI deploy to
  the HEAD commit's author and blocks it when that email is not a linked
  GitHub account. A bare `npx vercel` skips this, so `.vercelignore` is then
  the only thing keeping secrets out of the upload.
- Refuses to deploy while a migration is pending, checked against
  `SUPABASE_SESSION_URL` in `.env.supabase` — which is **dev's** connection.
  Running it before a production deploy prints a green light about a database
  that build will never talk to.
- Also refuses when `admin_permissions` is behind the code, because permissions
  are data and a deploy cannot carry them.

### Order

Migrate **after** the deploy when the new code tolerates both schemas, which is
the usual case for an additive change nothing reads yet. Migrate first only
when the deploy gate refuses and the change is additive. A migration commits
instantly with nothing to drain, so it is strictly more dangerous than a
deploy — see the `never-migrate-under-a-live-deployment` note.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
