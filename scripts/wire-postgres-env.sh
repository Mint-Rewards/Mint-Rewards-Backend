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

# --value and --non-interactive are both required. Piping the value on stdin
# satisfies only the first prompt: preview then asks for a git branch and
# development asks Secret-or-Config, and with stdin exhausted the command
# abandons the prompt and still exits 0. The first version of this script did
# exactly that and reported three successes having written one.
add() {
  local environment="$1"
  shift
  npx vercel env rm DATABASE_URL "$environment" --yes >/dev/null 2>&1 || true
  npx vercel env add DATABASE_URL "$environment" \
    --value "$URL" --sensitive --force --non-interactive "$@" >/dev/null 2>&1
}

# No --git-branch: a preview variable scoped to one branch applies only to
# that branch, and every preview deploy needs a database.
add production
add preview
add development

# Asked for, not assumed. `vercel env ls` is the only thing that actually
# knows, and the point of this script is that the deploy does not go out with
# a variable missing.
failed=0
for ENVIRONMENT in production preview development; do
  if npx vercel env ls "$ENVIRONMENT" 2>/dev/null \
       | awk 'NF>2 && $1=="DATABASE_URL"' | grep -q .; then
    echo "  DATABASE_URL confirmed present for $ENVIRONMENT"
  else
    echo "  DATABASE_URL MISSING for $ENVIRONMENT"
    failed=1
  fi
done
[ "$failed" -eq 0 ] || { echo; echo "Not all environments are set — do not deploy yet."; exit 1; }

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
