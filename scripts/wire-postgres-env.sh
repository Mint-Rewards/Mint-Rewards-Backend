#!/usr/bin/env bash
#
# Gives the deployed dev backend its DATABASE_URL.
#
# This must land BEFORE the BrandHub cutover is deployed. Without it,
# lib/postgres throws PostgresNotConfiguredError and every BrandHub route —
# login, signup, brand listing — fails, because those models no longer exist
# in Mongo for it to fall back to.
#
# The value is the transaction pooler (port 6543), not the session pooler:
# every serverless invocation is its own process, so session mode would burn a
# connection slot per invocation.
#
# Nothing is echoed. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v npx >/dev/null || { echo "npx not found"; exit 1; }

PROJECT="$(python3 -c "import json;print(json.load(open('.vercel/project.json')).get('projectName',''))")"
if [ "$PROJECT" != "mint-rewards-backend-dev" ]; then
  echo "Refusing to run: linked project is '$PROJECT', expected mint-rewards-backend-dev."
  echo "Vercel changes are meant to stay on the dev backend."
  exit 1
fi

URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"
[ -n "$URL" ] || { echo "DATABASE_URL is not set in .env"; exit 1; }

for ENVIRONMENT in production preview development; do
  npx vercel env rm DATABASE_URL "$ENVIRONMENT" --yes >/dev/null 2>&1 || true
  printf '%s' "$URL" | npx vercel env add DATABASE_URL "$ENVIRONMENT" >/dev/null
  echo "  DATABASE_URL set for $ENVIRONMENT"
done

echo
echo "Set. Deploy after this, not before:"
echo "  npx vercel deploy --prod"
echo
echo "Then check BrandHub login still answers — it is the route that proves"
echo "Postgres is reachable from the deployed function:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' \\"
echo "    -X POST https://mint-rewards-backend-dev.vercel.app/api/brandhub/auth/login \\"
echo "    -H 'content-type: application/json' \\"
echo "    -d '{\"email\":\"nobody@example.invalid\",\"password\":\"wrong\"}'"
echo "  401 means it reached the database and rejected the credentials."
echo "  500 means it did not."
