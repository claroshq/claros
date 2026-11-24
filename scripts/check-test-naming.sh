#!/usr/bin/env bash
# scripts/check-test-naming.sh - Enforce the *.db.test.ts naming convention.
#
# Convention: any test file that requires a Postgres connection (detected by
# referencing DATABASE_URL, TEST_DB_URL, or SEED_TEST_DATABASE_URL) MUST have
# a filename ending in .db.test.ts. This is enforced because:
#
#   - The release verify script excludes DB-dependent tests from the mirror
#     run using the glob **/*.db.test.ts. A file that needs the database but
#     does not follow the naming convention will fail in the mirror run even
#     though the check was designed to exclude it.
#   - The failure only surfaces at release time, not when the file is written.
#     This guard moves the detection to the normal test workflow.
#
# Detection: the script looks for the string DATABASE_URL, TEST_DB_URL, or
# SEED_TEST_DATABASE_URL in *.test.ts files (which would be non-DB-convention
# names). A .db.test.ts file satisfies the convention; other .test.ts files
# with those strings do not.
#
# Usage:
#   scripts/check-test-naming.sh          # called by test.sh before turbo test
#
# Exit codes:
#   0 - all database-dependent tests follow the .db.test.ts convention
#   1 - at least one test file uses DATABASE_URL but is not named .db.test.ts

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Find test files that reference the database but are not named *.db.test.ts.
# A *.db.test.ts file satisfies the convention regardless of what it contains.
# Only *.test.ts files that are NOT also *.db.test.ts are candidates for a violation.
VIOLATIONS=()

while IFS= read -r -d '' file; do
  # Skip if it is already a .db.test.ts file (satisfies the convention).
  # The -d '' + read handles filenames with spaces, though those are unlikely here.
  if [[ "$file" == *.db.test.ts ]]; then
    continue
  fi
  # The file ends in .test.ts but not .db.test.ts. Check if it uses the database.
  if grep -q "DATABASE_URL\|TEST_DB_URL\|SEED_TEST_DATABASE_URL" "$file" 2>/dev/null; then
    VIOLATIONS+=("$file")
  fi
done < <(find "$REPO_ROOT/packages" "$REPO_ROOT/apps" \
           -name "*.test.ts" \
           -not -path "*/node_modules/*" \
           -not -path "*/dist/*" \
           -print0 2>/dev/null)

if [ "${#VIOLATIONS[@]}" -eq 0 ]; then
  exit 0
fi

echo "" >&2
echo "ERROR: database-dependent test file(s) do not follow the .db.test.ts naming convention." >&2
echo "" >&2
echo "  Convention: test files that require Postgres must be named *.db.test.ts" >&2
echo "  Reason:     the release verify script uses **/*.db.test.ts to exclude DB tests" >&2
echo "              from the mirror run. A mismatch silently breaks the release gate." >&2
echo "" >&2
echo "  Rename the following file(s) from *.test.ts to *.db.test.ts:" >&2
for f in "${VIOLATIONS[@]}"; do
  # Show a short path relative to repo root for readability
  rel="${f#"$REPO_ROOT/"}"
  new_name="${rel%.test.ts}.db.test.ts"
  echo "    $rel  ->  $new_name" >&2
done
echo "" >&2
echo "  Then update any references to the old filename (imports, verify.sh banner)." >&2
echo "" >&2

exit 1
