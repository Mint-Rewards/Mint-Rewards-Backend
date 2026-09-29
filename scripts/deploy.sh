#!/usr/bin/env bash
# Deploy to Vercel from a copy of the tree with no .git in it.
#
# Vercel attaches the HEAD commit's author to a CLI deploy and blocks it when
# that email does not resolve to a GitHub account linked to the Vercel account.
# Ours does not — the Vercel account and the GitHub account are different
# identities. Staging without .git leaves no commit to attribute.
#
# Deploys go to mint-rewards-backend-dev. Production is a separate project and
# is deliberately not touched from here.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

tar --exclude=.git --exclude=node_modules --exclude=.next --exclude='.env*' \
    --exclude=.vercel --exclude=__tests__ --exclude=coverage \
    -cf - -C "$root" . | tar -xf - -C "$stage"

mkdir -p "$stage/.vercel"
cp "$root/.vercel/project.json" "$stage/.vercel/project.json"

cd "$stage"
exec vercel deploy "$@"
