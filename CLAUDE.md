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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
