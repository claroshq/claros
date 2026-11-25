#!/usr/bin/env bash
# scripts/check-docs.sh - Guards for public docs and copy.
#
# Fails when README, docs/ or the dashboard misstate the product:
# a hosted Cloud edition, removed hostnames, the retired edition switch, or
# claims that Postgres support was dropped. Also fails on em dashes in docs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGETS=(README.md CONTRIBUTING.md SECURITY.md CHANGELOG.md docs apps/dashboard/src)

PATTERNS=(
  'Cloud edition'
  'hosted edition'
  'app\.claros\.org'
  'api\.claros\.org'
  'CLAROS_EDITION='
  'dropped Postgres'
  'no longer supports Postgres'
  'Postgres is deprecated'
  'Cloudflare only'
  'Workers only'
  'requires Cloudflare'
)

status=0
EXISTING=()
for f in "${TARGETS[@]}"; do
  [ -e "$f" ] && EXISTING+=("$f")
done
for pattern in "${PATTERNS[@]}"; do
  # CHANGELOG may name retired things when it records their removal.
  if hits=$(grep -rniE "$pattern" "${EXISTING[@]}" --exclude=CHANGELOG.md --exclude=BRAND.md); then
    echo "docs check: forbidden phrase '$pattern':" >&2
    echo "$hits" >&2
    status=1
  fi
done

EM_DASH="$(printf '\xe2\x80\x94')"
DOC_FILES=()
for f in README.md CONTRIBUTING.md SECURITY.md CHANGELOG.md docs/guide docs/architecture.md docs/install; do
  [ -e "$f" ] && DOC_FILES+=("$f")
done
if hits=$(grep -rn "$EM_DASH" "${DOC_FILES[@]}"); then
  echo "docs check: em dash found (use a regular hyphen):" >&2
  echo "$hits" >&2
  status=1
fi

# The config JSON Schema must match the Zod schema it is generated from.
# Needs the built core package; where it is not built (the lint job), the
# core test suite runs the same comparison.
if [ -f packages/core/dist/index.js ] && command -v node >/dev/null 2>&1; then
  if ! node scripts/gen-config-schema.mjs --check; then
    status=1
  fi
else
  echo "docs check: config schema check skipped (packages/core not built; tests check it)" >&2
fi

exit "$status"
