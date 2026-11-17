#!/usr/bin/env bash
# Build the plugin the way `bb plugin install git:...` does: production
# dependencies only, no install scripts. Run from a clean checkout.
set -euo pipefail
bb_version=$(node -p 'require("./package-lock.json").packages["node_modules/bb-app"].version')
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git ls-files -z | xargs -0 cp --parents -t "$tmp"
cd "$tmp"
npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
npx --yes --package "bb-app@$bb_version" bb plugin build .
