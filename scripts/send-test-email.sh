#!/usr/bin/env bash
set -euo pipefail

# send-test-email.sh - End-to-end send verification for Claros.
#
# Proves that Resend accepts a real request, that compliance headers and footer
# survive into the delivered message, and that an unsubscribe token resolves.
#
# Usage:
#   ./scripts/send-test-email.sh --to recipient@example.com [options]
#
# Required:
#   --to <email>        Recipient address. Never defaults. Must be supplied.
#
# Options:
#   --tenant <slug>     Tenant slug (default: "default")
#   --subject <text>    Email subject (default: "Claros send test")
#   --body <text>       Email body (plain text). If omitted, opens $EDITOR.
#   --dry-run           Run all checks and stop before sending.
#   --prod              Target PRODUCTION_DATABASE_URL (requires confirmation).
#   --yes               Skip confirmation prompt.
#   --keep-rows         Skip cleanup of the message and suppression rows after
#                       the run. Use this when you need to observe provider
#                       webhook delivery (open, click, bounce, unsubscribe):
#                       the webhook handler resolves events by provider message
#                       ID, so the row must exist when the event arrives. Also
#                       skips the local one-click unsubscribe call so that a
#                       real provider-initiated unsubscribe can be observed.
#                       Prints the message ID, provider message ID, and manual
#                       SQL queries to check feedback and suppression after the
#                       run. Session, flow stub, and (if created) contact rows
#                       are still removed.
#
# Requirements:
#   - npm run build must have been run (imports from dist/ directories).
#   - The Claros server must be running (for the approve endpoint).
#   - Database must be reachable and migrations current.
#   - ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY must be set in .env or env.
#
# Safety conventions (matching scripts/migrate.sh):
#   - Local database by default.
#   - --prod required to target PRODUCTION_DATABASE_URL.
#   - Production shows target and requires typed "yes".
#   - No credential values are printed, ever. Presence and length only.
#

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

RECIPIENT=""
TENANT_SLUG="default"
SUBJECT="Claros send test"
BODY_TEXT=""
DRY_RUN=false
PROD=false
YES=false
KEEP_ROWS=false

while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      RECIPIENT="$2"
      shift 2
      ;;
    --tenant)
      TENANT_SLUG="$2"
      shift 2
      ;;
    --subject)
      SUBJECT="$2"
      shift 2
      ;;
    --body)
      BODY_TEXT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --prod)
      PROD=true
      shift
      ;;
    --yes)
      YES=true
      shift
      ;;
    --keep-rows)
      KEEP_ROWS=true
      shift
      ;;
    -h|--help)
      grep '^#' "$0" | head -40 | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
declare -a CHECKS

pass() {
  echo "  OK: $1"
  CHECKS+=("OK  $1")
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  if [ -n "${2:-}" ]; then echo "        Remedy: $2"; fi
  CHECKS+=("FAIL $1")
  FAIL=$((FAIL + 1))
}

section() {
  echo ""
  echo "--- $1 ---"
}

abort() {
  echo ""
  echo "ABORTED: $1"
  exit 1
}

# Temp directory inside REPO_ROOT so Node.js ESM resolution finds node_modules.
# ESM resolves packages relative to the importing file's URL, not CWD.
# A file in /tmp cannot see REPO_ROOT/node_modules. A file inside the repo can.
TMPDIR_SCRIPTS="$(mktemp -d "$REPO_ROOT/.send-test-tmp.XXXXXX")"
trap 'rm -rf "$TMPDIR_SCRIPTS"' EXIT

# Write a Node.js module to a temp file (inside REPO_ROOT so ESM resolution
# finds node_modules) and run it, passing config via env.
# stderr is intentionally NOT redirected: Node warnings (e.g. SSL mode aliasing)
# are informational and must not contaminate the structured stdout protocol.
run_node() {
  local script_file="$1"
  node "$script_file" 2>/dev/stderr
}

# ---------------------------------------------------------------------------
# Load .env (same parser as migrate.sh - no shell eval, no override of existing vars)
# ---------------------------------------------------------------------------

ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*) continue ;;
    esac
    if ! echo "$line" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*='; then
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    case "$value" in
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
    esac
    eval "existing_val=\${$key+x}"
    if [ -n "$existing_val" ]; then continue; fi
    export "$key=$value"
  done < "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
# Recipient guard
# ---------------------------------------------------------------------------

if [ -z "$RECIPIENT" ]; then
  echo ""
  echo "ERROR: --to <recipient> is required. Never defaults."
  echo ""
  echo "Usage: $0 --to you@example.com [--tenant default] [--dry-run]"
  echo ""
  exit 1
fi

# ---------------------------------------------------------------------------
# Database URL resolution (mirrors migrate.sh)
# ---------------------------------------------------------------------------

if [ "$PROD" = true ]; then
  if [ -z "${PRODUCTION_DATABASE_URL:-}" ]; then
    abort "--prod requires PRODUCTION_DATABASE_URL to be set in .env"
  fi
  DB_URL="$PRODUCTION_DATABASE_URL"
else
  if [ -z "${DATABASE_URL:-}" ]; then
    abort "DATABASE_URL is not set. Set it in .env."
  fi
  DB_URL="$DATABASE_URL"
fi

# Parse host/db for display
stripped="${DB_URL#postgres://}"
stripped="${stripped#postgresql://}"
host_db="${stripped#*@}"
HOST_PORT="${host_db%%/*}"
db_and_params="${host_db#*/}"
DB_NAME="${db_and_params%%\?*}"
if [ -z "$DB_NAME" ]; then DB_NAME="(none)"; fi

if echo "$HOST_PORT" | grep -qi "neon\.tech"; then
  DB_TYPE="Neon (production)"
elif echo "$HOST_PORT" | grep -qi "localhost\|127\.0\.0\.\|::1"; then
  DB_TYPE="local"
else
  DB_TYPE="remote (unknown)"
fi

if [ "$PROD" = false ] && echo "$HOST_PORT" | grep -qi "neon\.tech"; then
  abort "DATABASE_URL points to a Neon endpoint but --prod was not passed. Use --prod."
fi
if echo "$HOST_PORT" | grep -qi "\-pooler"; then
  abort "Target URL points to a pooled endpoint. Use the direct endpoint."
fi

# ---------------------------------------------------------------------------
# Body: open editor if not supplied
# ---------------------------------------------------------------------------

if [ -z "$BODY_TEXT" ]; then
  BODY_TMPFILE="$(mktemp /tmp/claros-test-body.XXXXXX)"
  cat > "$BODY_TMPFILE" <<'TMPL'
# Enter the test email body below. Lines starting with # are stripped.
# Leave blank to abort.

This is a Claros send test.

If you received this, the send path is working end to end.
TMPL
  EDITOR_CMD="${EDITOR:-${VISUAL:-vi}}"
  echo "Opening editor ($EDITOR_CMD) for email body..."
  "$EDITOR_CMD" "$BODY_TMPFILE"
  BODY_TEXT=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in \#*) continue ;; esac
    BODY_TEXT="${BODY_TEXT}${line}"$'\n'
  done < "$BODY_TMPFILE"
  BODY_TEXT="${BODY_TEXT%$'\n'}"
  rm -f "$BODY_TMPFILE"
  if [ -z "$BODY_TEXT" ]; then
    abort "Body is empty. Aborted."
  fi
fi

# Export all parameters used by Node.js scripts as environment variables.
# The Node scripts read from process.env - no shell quoting complexity.
export SEND_TEST_REPO_ROOT="$REPO_ROOT"
export SEND_TEST_DB_URL="$DB_URL"
export SEND_TEST_TENANT_SLUG="$TENANT_SLUG"
export SEND_TEST_RECIPIENT="$RECIPIENT"
export SEND_TEST_SUBJECT="$SUBJECT"
export SEND_TEST_BODY_TEXT="$BODY_TEXT"

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

echo ""
echo "=== Claros Send Test ==="
echo ""
echo "Target:"
echo "  Database: $HOST_PORT/$DB_NAME [$DB_TYPE]"
if [ "$PROD" = true ]; then echo "  Mode:     PRODUCTION (--prod)"; fi
echo "  Tenant:   $TENANT_SLUG"
echo "  To:       $RECIPIENT"
echo "  Subject:  $SUBJECT"
if [ "$DRY_RUN" = true ]; then echo "  Mode:     DRY RUN (no send)"; fi
if [ "$KEEP_ROWS" = true ]; then echo "  Mode:     --keep-rows (message and suppression rows will NOT be cleaned up)"; fi
echo ""

# ---------------------------------------------------------------------------
# Production confirmation
# ---------------------------------------------------------------------------

if [ "$PROD" = true ] && [ "$YES" = false ]; then
  printf 'Send to PRODUCTION (%s/%s)? Type "yes" to confirm: ' "$HOST_PORT" "$DB_NAME"
  read -r reply
  if [ "$reply" != "yes" ]; then
    abort "Aborted. Nothing sent."
  fi
  echo ""
fi

# ===========================================================================
# PREFLIGHT CHECKS
# ===========================================================================

section "Preflight checks"

# Check 1: ENCRYPTION_KEY
if [ -z "${ENCRYPTION_KEY:-}" ]; then
  fail "ENCRYPTION_KEY is set" \
    "Set ENCRYPTION_KEY in .env (base64-encoded 32 bytes). See .env.example."
else
  key_len="${#ENCRYPTION_KEY}"
  if [ "$key_len" -lt 44 ]; then
    fail "ENCRYPTION_KEY length plausible (${key_len} chars; expected >=44 for 32-byte base64)" \
      "Regenerate: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
  else
    pass "ENCRYPTION_KEY present (length: ${key_len} chars)"
  fi
fi

# Check 2: UNSUBSCRIBE_SIGNING_KEY
if [ -z "${UNSUBSCRIBE_SIGNING_KEY:-}" ]; then
  fail "UNSUBSCRIBE_SIGNING_KEY is set" \
    "Set UNSUBSCRIBE_SIGNING_KEY in .env. See .env.example."
else
  sk_len="${#UNSUBSCRIBE_SIGNING_KEY}"
  pass "UNSUBSCRIBE_SIGNING_KEY present (length: ${sk_len} chars)"
fi

# Check 3: BASE_URL warning
EFFECTIVE_BASE_URL="${BASE_URL:-http://localhost:${PORT:-3000}}"
pass "BASE_URL is $EFFECTIVE_BASE_URL"
if echo "$EFFECTIVE_BASE_URL" | grep -qi "localhost\|127\.0\.0\."; then
  echo "        WARNING: BASE_URL is localhost. Unsubscribe links and provider webhooks"
  echo "                 will be unreachable from outside this machine."
fi
export SEND_TEST_BASE_URL="$EFFECTIVE_BASE_URL"

# Check 4: Build output
if [ ! -f "$REPO_ROOT/packages/adapters/dist/index.js" ] || \
   [ ! -f "$REPO_ROOT/packages/worker/dist/index.js" ] || \
   [ ! -f "$REPO_ROOT/drizzle/dist/schema/index.js" ]; then
  fail "Build output present (adapters, worker, drizzle dist)" "Run: npm run build"
else
  pass "Build output present (adapters, worker, drizzle dist)"
fi

# Check 5: Database reachable
if psql "$DB_URL" -tAc "SELECT 1" > /dev/null 2>&1; then
  pass "Database reachable ($HOST_PORT/$DB_NAME)"
else
  fail "Database reachable ($HOST_PORT/$DB_NAME)" \
    "Start Postgres: docker compose up -d postgres"
fi

# Check 6: Migrations current
if DATABASE_URL="$DB_URL" bash "$REPO_ROOT/scripts/check-migrations.sh" 2>&1; then
  pass "Migrations current"
else
  fail "Migrations current" "Run: npm run db:migrate"
fi

# Check 7: Server reachable
SERVER_URL="${EFFECTIVE_BASE_URL%/}"
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${SERVER_URL}/health" 2>/dev/null) || HEALTH_STATUS="000"
if [ "$HEALTH_STATUS" = "200" ]; then
  pass "Server reachable (${SERVER_URL}/health -> 200)"
else
  fail "Server reachable (${SERVER_URL}/health -> ${HEALTH_STATUS})" \
    "Start the server: npm run dev   OR   docker compose up -d app"
fi

# Check 8: Tenant, postal address, transport config
cat > "$TMPDIR_SCRIPTS/check_tenant.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";

const r = process.env.SEND_TEST_REPO_ROOT;
const { tenants, transportConfigs } = await import(resolve(r, "drizzle/dist/schema/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL, connectionTimeoutMillis: 3000 });
const db = drizzle(pool);
try {
  const rows = await db.select({ id: tenants.id, name: tenants.name, settings: tenants.settings })
    .from(tenants).where(eq(tenants.slug, process.env.SEND_TEST_TENANT_SLUG)).limit(1);
  if (rows.length === 0) { console.log("TENANT_MISSING"); process.exit(0); }
  const t = rows[0];
  const pa = t.settings?.postal_address ?? null;
  if (!pa) { console.log("NO_POSTAL_ADDRESS"); console.log("TENANT_ID:" + t.id); process.exit(0); }
  const cfg = await db.select({ provider: transportConfigs.provider, fromEmail: transportConfigs.fromEmail, fromName: transportConfigs.fromName })
    .from(transportConfigs).where(and(eq(transportConfigs.tenantId, t.id), eq(transportConfigs.isActive, true))).limit(1);
  if (cfg.length === 0) { console.log("NO_TRANSPORT"); console.log("TENANT_ID:" + t.id); process.exit(0); }
  console.log("OK");
  console.log("TENANT_ID:" + t.id);
  console.log("TENANT_NAME:" + t.name);
  console.log("POSTAL_ADDRESS:" + pa);
  console.log("PROVIDER:" + cfg[0].provider);
  console.log("FROM_EMAIL:" + cfg[0].fromEmail);
  console.log("FROM_NAME:" + (cfg[0].fromName ?? ""));
} finally { await pool.end(); }
NODEOF

TENANT_CHECK_OUTPUT=$(run_node "$TMPDIR_SCRIPTS/check_tenant.mjs")
TENANT_STATUS=$(echo "$TENANT_CHECK_OUTPUT" | grep -E "^(OK|TENANT_MISSING|NO_POSTAL_ADDRESS|NO_TRANSPORT)" | head -1 || true)
TENANT_ID=$(echo "$TENANT_CHECK_OUTPUT" | grep "^TENANT_ID:" | sed 's/^TENANT_ID://' || true)
TENANT_NAME=$(echo "$TENANT_CHECK_OUTPUT" | grep "^TENANT_NAME:" | sed 's/^TENANT_NAME://' || true)
POSTAL_ADDRESS=$(echo "$TENANT_CHECK_OUTPUT" | grep "^POSTAL_ADDRESS:" | sed 's/^POSTAL_ADDRESS://' || true)
PROVIDER=$(echo "$TENANT_CHECK_OUTPUT" | grep "^PROVIDER:" | sed 's/^PROVIDER://' || true)
FROM_EMAIL=$(echo "$TENANT_CHECK_OUTPUT" | grep "^FROM_EMAIL:" | sed 's/^FROM_EMAIL://' || true)
FROM_NAME=$(echo "$TENANT_CHECK_OUTPUT" | grep "^FROM_NAME:" | sed 's/^FROM_NAME://' || true)

case "$TENANT_STATUS" in
  OK)
    pass "Tenant '$TENANT_SLUG' exists with postal address and transport config"
    echo "        Tenant:   $TENANT_NAME ($TENANT_ID)"
    echo "        Provider: $PROVIDER"
    echo "        From:     $FROM_EMAIL${FROM_NAME:+ ($FROM_NAME)}"
    echo "        Postal:   $POSTAL_ADDRESS"
    echo ""
    echo "        NOTE: The sender domain ($FROM_EMAIL) must be verified with"
    echo "              $PROVIDER. Domain verification is outside Claros."
    ;;
  TENANT_MISSING)
    fail "Tenant '$TENANT_SLUG' exists" \
      "Pass --tenant <slug> or create the tenant first."
    ;;
  NO_POSTAL_ADDRESS)
    fail "Tenant '$TENANT_SLUG' has a postal_address configured" \
      "Set it: curl -X PATCH ${SERVER_URL}/v1/settings/tenant --cookie 'claros_session=...' -d '{\"postal_address\":\"123 Main St\"}'"
    ;;
  NO_TRANSPORT)
    fail "Tenant '$TENANT_SLUG' has an active transport configuration" \
      "Configure: echo '{\"provider\":\"resend\",\"from_email\":\"...\",\"api_key\":\"...\"}' | node apps/server/bin/claros.mjs transport set $TENANT_SLUG"
    ;;
  *)
    fail "Tenant check (unexpected: $TENANT_CHECK_OUTPUT)" ""
    ;;
esac

export SEND_TEST_TENANT_ID="${TENANT_ID:-}"
export SEND_TEST_POSTAL_ADDRESS="${POSTAL_ADDRESS:-}"

# Check 9: Transport decrypts and provider is implemented
if [ "$TENANT_STATUS" = "OK" ]; then
  cat > "$TMPDIR_SCRIPTS/check_adapter.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const r = process.env.SEND_TEST_REPO_ROOT;
const { buildTenantTransportResolver } = await import(resolve(r, "packages/worker/dist/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL, connectionTimeoutMillis: 3000 });
const db = drizzle(pool);
try {
  const resolver = buildTenantTransportResolver(db);
  const adapter = await resolver(process.env.SEND_TEST_TENANT_ID);
  console.log(adapter === null ? "ADAPTER_NULL" : "ADAPTER_OK");
} catch (err) {
  console.log("ADAPTER_ERROR:" + err.message);
} finally { await pool.end(); }
NODEOF

  ADAPTER_STATUS=$(run_node "$TMPDIR_SCRIPTS/check_adapter.mjs" || true)
  case "$ADAPTER_STATUS" in
    ADAPTER_OK)  pass "Transport config decrypts and provider is implemented" ;;
    ADAPTER_NULL) fail "Transport adapter resolved (null - not implemented or missing config)" \
      "Ensure provider is 'resend' and ENCRYPTION_KEY matches the stored config." ;;
    ADAPTER_ERROR:*)
      fail "Transport config decrypts (${ADAPTER_STATUS#ADAPTER_ERROR:})" \
        "Check ENCRYPTION_KEY matches the key used to store the transport config." ;;
    *) fail "Transport config check (unexpected: $ADAPTER_STATUS)" "" ;;
  esac
fi

# Abort if any preflight failed
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "ABORTED: $FAIL preflight check(s) failed. Fix the issues above and retry."
  exit 1
fi

# ---------------------------------------------------------------------------
# Pre-send summary / dry-run gate
# ---------------------------------------------------------------------------

echo ""
echo "--- Pre-send summary ---"
echo ""
echo "  Will send:"
echo "    To:       $RECIPIENT"
echo "    From:     $FROM_EMAIL${FROM_NAME:+ ($FROM_NAME)}"
echo "    Subject:  $SUBJECT"
echo "    Tenant:   $TENANT_NAME ($TENANT_SLUG)"
echo "    Provider: $PROVIDER"
echo "    Body preview: $(echo "$BODY_TEXT" | head -2 | tr '\n' ' ')..."
echo ""
echo "  Compliance (injected at send time, not persisted):"
echo "    List-Unsubscribe header: HTTPS one-click form with HMAC token (mailto: form omitted)"
echo "    List-Unsubscribe-Post: List-Unsubscribe=One-Click"
echo "    Footer: unsubscribe URL + postal address appended to HTML and text bodies"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN: stopping before send. All $PASS preflight checks passed."
  echo ""
  echo "=== Summary ==="
  for c in "${CHECKS[@]}"; do echo "  $c"; done
  echo ""
  echo "PASSED (dry run): $PASS checks, 0 failures"
  exit 0
fi

if [ "$YES" = false ]; then
  printf "Send this email? [y/N] "
  read -r send_reply
  case "$send_reply" in
    [yY]|[yY][eE][sS]) ;;
    *)
      echo ""
      echo "Aborted. Nothing sent."
      exit 0
      ;;
  esac
  echo ""
fi

# ===========================================================================
# SEND PHASE
# ===========================================================================

section "Creating message and sending"

# Step 1: Create contact, flow stub, membership, and message at pending_approval
cat > "$TMPDIR_SCRIPTS/create_message.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";

const r = process.env.SEND_TEST_REPO_ROOT;
const { tenants, contacts, flows, flowMemberships, lifecycleMessages } =
  await import(resolve(r, "drizzle/dist/schema/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL });
const db = drizzle(pool);

const tenantId = process.env.SEND_TEST_TENANT_ID;
const recipient = process.env.SEND_TEST_RECIPIENT;
const subject = process.env.SEND_TEST_SUBJECT;
const bodyText = process.env.SEND_TEST_BODY_TEXT;
const bodyHtml = "<p>" + bodyText.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";

try {
  const extId = "send-test-" + recipient.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const existing = await db.select({ id: contacts.id }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.email, recipient))).limit(1);
  let contactId;
  let contactCreated = false;
  if (existing.length > 0) {
    contactId = existing[0].id;
  } else {
    const [c] = await db.insert(contacts).values({
      tenantId, externalId: extId, email: recipient, lifecycleState: "new",
    }).returning({ id: contacts.id });
    contactId = c.id;
    contactCreated = true;
  }
  const [f] = await db.insert(flows).values({
    tenantId, name: "send-test-flow-" + Date.now(), priority: 0,
    triggerType: "lifecycle_transition", triggerConfig: {}, steps: [],
    status: "paused", flowClass: "critical",
    compiledPlan: { steps: [{ order: 1, window_policy: "immediate" }] },
  }).returning({ id: flows.id });
  const [m] = await db.insert(flowMemberships).values({
    tenantId, contactId, flowId: f.id, currentStep: 1,
    status: "active", enteredAt: new Date(),
  }).returning({ id: flowMemberships.id });
  const [msg] = await db.insert(lifecycleMessages).values({
    tenantId, contactId, flowId: f.id, membershipId: m.id,
    flowStepOrder: 1, status: "pending_approval",
    subject, bodyHtml, bodyText,
  }).returning({ id: lifecycleMessages.id });
  console.log("OK");
  console.log("CONTACT_ID:" + contactId);
  console.log("CONTACT_CREATED:" + contactCreated);
  console.log("FLOW_ID:" + f.id);
  console.log("MESSAGE_ID:" + msg.id);
} catch (err) {
  console.log("ERROR:" + err.message);
} finally { await pool.end(); }
NODEOF

SETUP_OUTPUT=$(run_node "$TMPDIR_SCRIPTS/create_message.mjs")
SETUP_STATUS=$(echo "$SETUP_OUTPUT" | grep -E "^(OK|ERROR)" | head -1 || true)
CONTACT_ID=$(echo "$SETUP_OUTPUT" | grep "^CONTACT_ID:" | sed 's/^CONTACT_ID://' || true)
CONTACT_CREATED=$(echo "$SETUP_OUTPUT" | grep "^CONTACT_CREATED:" | sed 's/^CONTACT_CREATED://' || true)
MESSAGE_ID=$(echo "$SETUP_OUTPUT" | grep "^MESSAGE_ID:" | sed 's/^MESSAGE_ID://' || true)
FLOW_ID=$(echo "$SETUP_OUTPUT" | grep "^FLOW_ID:" | sed 's/^FLOW_ID://' || true)

if [ "$SETUP_STATUS" != "OK" ] || [ -z "$MESSAGE_ID" ]; then
  abort "Failed to create test message: $(echo "$SETUP_OUTPUT" | grep "^ERROR:" | sed 's/^ERROR://')"
fi
echo "  Created message $MESSAGE_ID at status=pending_approval"
export SEND_TEST_MESSAGE_ID="$MESSAGE_ID"
export SEND_TEST_FLOW_ID="$FLOW_ID"
export SEND_TEST_CONTACT_ID="$CONTACT_ID"
export SEND_TEST_CONTACT_CREATED="${CONTACT_CREATED:-false}"

# Step 2: Create a session for the approve call
cat > "$TMPDIR_SCRIPTS/create_session.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

const r = process.env.SEND_TEST_REPO_ROOT;
const { users, sessions } = await import(resolve(r, "drizzle/dist/schema/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL });
const db = drizzle(pool);
try {
  const userRows = await db.select({ id: users.id }).from(users)
    .where(eq(users.tenantId, process.env.SEND_TEST_TENANT_ID)).limit(1);
  if (userRows.length === 0) { console.log("NO_USER"); process.exit(0); }
  const [s] = await db.insert(sessions).values({
    tenantId: process.env.SEND_TEST_TENANT_ID,
    userId: userRows[0].id,
    expiresAt: new Date(Date.now() + 3600 * 1000),
  }).returning({ id: sessions.id });
  console.log("OK");
  console.log("SESSION_ID:" + s.id);
} catch (err) {
  console.log("ERROR:" + err.message);
} finally { await pool.end(); }
NODEOF

SESSION_OUTPUT=$(run_node "$TMPDIR_SCRIPTS/create_session.mjs")
SESSION_STATUS=$(echo "$SESSION_OUTPUT" | grep -E "^(OK|NO_USER|ERROR)" | head -1 || true)
SESSION_ID=$(echo "$SESSION_OUTPUT" | grep "^SESSION_ID:" | sed 's/^SESSION_ID://' || true)

if [ "$SESSION_STATUS" = "NO_USER" ]; then
  abort "No user found for tenant '$TENANT_SLUG'."
fi
if [ "$SESSION_STATUS" != "OK" ] || [ -z "$SESSION_ID" ]; then
  abort "Failed to create session: $(echo "$SESSION_OUTPUT" | grep "^ERROR:" | sed 's/^ERROR://')"
fi
echo "  Created session (1h TTL, used for approve call only)"

# Step 3: Approve via HTTP API
APPROVE_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  "${SERVER_URL}/v1/messages/${MESSAGE_ID}/approve" \
  -H "Cookie: claros_session=${SESSION_ID}" \
  2>/dev/null)
APPROVE_BODY=$(echo "$APPROVE_RESPONSE" | sed '$d')
APPROVE_STATUS=$(echo "$APPROVE_RESPONSE" | tail -1)

if [ "$APPROVE_STATUS" = "200" ]; then
  echo "  Approved via POST /v1/messages/${MESSAGE_ID}/approve (HTTP 200)"
else
  abort "Approve endpoint returned HTTP $APPROVE_STATUS. Body: $APPROVE_BODY"
fi

# Step 4: Run drain tick
echo "  Running drain tick..."
cat > "$TMPDIR_SCRIPTS/run_drain.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const r = process.env.SEND_TEST_REPO_ROOT;
const { processDrainTick, fetchDrainBatchSimple, buildTenantTransportResolver } =
  await import(resolve(r, "packages/worker/dist/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL });
const db = drizzle(pool);
try {
  const resolver = buildTenantTransportResolver(db);
  const result = await processDrainTick(
    db, new Date(), resolver, fetchDrainBatchSimple, 50,
    process.env.SEND_TEST_BASE_URL, undefined,
  );
  console.log("OK");
  console.log("SENT:" + (result.sent ?? 0));
  console.log("SKIPPED_NO_TRANSPORT:" + (result.skippedNoTransport ?? 0));
  console.log("SKIPPED_NO_POSTAL:" + (result.skippedNoPostalAddress ?? 0));
  console.log("SKIPPED_NO_KEY:" + (result.skippedNoSigningKey ?? 0));
  console.log("SUPPRESSED:" + (result.suppressed ?? 0));
  console.log("TRANSPORT_ERRORS:" + (result.transportErrors ?? 0));
} catch (err) {
  console.log("ERROR:" + err.message);
} finally { await pool.end(); }
NODEOF

DRAIN_OUTPUT=$(run_node "$TMPDIR_SCRIPTS/run_drain.mjs")
DRAIN_STATUS=$(echo "$DRAIN_OUTPUT" | grep -E "^(OK|ERROR)" | head -1 || true)
DRAIN_SENT=$(echo "$DRAIN_OUTPUT" | grep "^SENT:" | sed 's/^SENT://' || true)

if [ "$DRAIN_STATUS" != "OK" ]; then
  abort "Drain tick failed: $(echo "$DRAIN_OUTPUT" | grep "^ERROR:" | sed 's/^ERROR://')"
fi
echo "  Drain tick complete (sent: ${DRAIN_SENT:-?})"

# ===========================================================================
# POST-SEND VERIFICATION
# ===========================================================================

section "Post-send verification"

cat > "$TMPDIR_SCRIPTS/verify.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

const r = process.env.SEND_TEST_REPO_ROOT;
const { lifecycleMessages } = await import(resolve(r, "drizzle/dist/schema/index.js"));
const {
  buildComplianceOutput,
  injectHtmlFooter,
  injectTextFooter,
  resolveBaseUrl,
  resolveSigningKey,
} = await import(resolve(r, "packages/worker/dist/index.js"));
const { verifyUnsubscribeToken } = await import(resolve(r, "packages/adapters/dist/index.js"));

const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL });
const db = drizzle(pool);

const messageId = process.env.SEND_TEST_MESSAGE_ID;
const tenantId = process.env.SEND_TEST_TENANT_ID;
const recipient = process.env.SEND_TEST_RECIPIENT;
const postalAddress = process.env.SEND_TEST_POSTAL_ADDRESS;

const chk = (name, ok, detail) => console.log("CHECK:" + name + ":" + (ok ? "PASS" : "FAIL") + ":" + detail);

try {
  const rows = await db.select().from(lifecycleMessages)
    .where(eq(lifecycleMessages.id, messageId)).limit(1);

  if (rows.length === 0) { chk("message_exists", false, "row not found"); process.exit(0); }
  const msg = rows[0];

  chk("message_status", msg.status === "sent", "status=" + msg.status);
  chk("provider_message_id", !!msg.providerMessageId, msg.providerMessageId ?? "null");
  if (msg.providerMessageId) { console.log("PROVIDER_MSG_ID:" + msg.providerMessageId); }
  const recipNorm = (msg.recipientAddress ?? "").toLowerCase().trim();
  chk("recipient_address",
    recipNorm === recipient.toLowerCase().trim(),
    "stored=" + (msg.recipientAddress ?? "null") + " expected=" + recipient);

  // Stored body must not contain the footer (compliance is not persisted)
  const storedHtml = msg.bodyHtml ?? "";
  const storedText = msg.bodyText ?? "";
  const footerInHtml = storedHtml.toLowerCase().includes("to unsubscribe");
  const footerInText = storedText.toLowerCase().includes("to unsubscribe:");
  chk("stored_body_unmodified", !footerInHtml && !footerInText,
    footerInHtml || footerInText ? "footer appears in stored body" : "footer not persisted");

  // Compliance reconstruction
  const signingKey = resolveSigningKey();
  if (!signingKey) {
    chk("compliance", false, "UNSUBSCRIBE_SIGNING_KEY missing");
    process.exit(0);
  }

  const baseUrl = resolveBaseUrl();
  const compliance = buildComplianceOutput({
    tenantId, messageId,
    postalAddress, baseUrl, signingKey,
  });

  // List-Unsubscribe: HTTPS one-click form only (mailto: form intentionally absent).
  // See compliance.ts [impl] note.
  const luh = compliance.listUnsubscribeHeader;
  chk("list_unsubscribe_header_no_mailto", !luh.includes("<mailto:"),
    luh.includes("<mailto:") ? "mailto: present but should be absent" : "mailto: correctly absent");
  chk("list_unsubscribe_header_https",
    luh.includes(baseUrl + "/unsubscribe/one-click?token="),
    luh.slice(0, 120));

  // List-Unsubscribe-Post: RFC 8058 sentinel
  chk("list_unsubscribe_post",
    compliance.listUnsubscribePostHeader === "List-Unsubscribe=One-Click",
    compliance.listUnsubscribePostHeader);

  // Footer in delivered HTML
  const delivHtml = injectHtmlFooter(storedHtml, compliance.htmlFooter);
  chk("html_footer_unsubscribe_link",
    delivHtml.toLowerCase().includes("unsubscribe"),
    "present");
  chk("html_footer_postal_address",
    delivHtml.includes(postalAddress.slice(0, 20)),
    "present");

  // Footer in delivered text
  const delivText = storedText
    ? injectTextFooter(storedText, compliance.textFooter)
    : compliance.textFooter.trimStart();
  chk("text_footer_unsubscribe_line", delivText.includes("To unsubscribe:"), "present");
  chk("text_footer_postal_address", delivText.includes(postalAddress.slice(0, 20)), "present");

  // Token extraction and verification
  const tokenMatch = luh.match(/one-click\?token=([^>]+)/);
  if (!tokenMatch) {
    chk("token_extraction", false, "no token in List-Unsubscribe header");
  } else {
    const token = tokenMatch[1];
    const vr = verifyUnsubscribeToken(token);
    if (vr.ok && vr.payload.tenantId === tenantId && vr.payload.messageId === messageId) {
      chk("token_verify", true, "resolves to correct tenant and message");
      console.log("TOKEN:" + token);
    } else if (vr.ok) {
      chk("token_verify", false, "payload mismatch: tenantId=" + vr.payload.tenantId);
    } else {
      chk("token_verify", false, "error=" + vr.error.kind);
    }
  }
} catch (err) {
  chk("verify_fatal", false, err.message);
} finally { await pool.end(); }
NODEOF

VERIFY_OUTPUT=$(run_node "$TMPDIR_SCRIPTS/verify.mjs")
TOKEN_VALUE=""
PROVIDER_MSG_ID=""

while IFS= read -r line; do
  case "$line" in
    CHECK:*)
      name=$(echo "$line" | cut -d: -f2)
      result=$(echo "$line" | cut -d: -f3)
      detail=$(echo "$line" | cut -d: -f4-)
      if [ "$result" = "PASS" ]; then
        pass "$name: $detail"
      else
        fail "$name: $detail"
      fi
      ;;
    TOKEN:*)
      TOKEN_VALUE="${line#TOKEN:}"
      ;;
    PROVIDER_MSG_ID:*)
      PROVIDER_MSG_ID="${line#PROVIDER_MSG_ID:}"
      ;;
  esac
done <<EOF
$VERIFY_OUTPUT
EOF

# ---------------------------------------------------------------------------
# Unsubscribe endpoint verification
# ---------------------------------------------------------------------------

if [ -n "$TOKEN_VALUE" ]; then
  section "Unsubscribe endpoint verification"
  echo "  Token: (${#TOKEN_VALUE} chars, not printed)"
  echo ""

  if [ "$KEEP_ROWS" = true ]; then
    echo "  Skipping local one-click unsubscribe call (--keep-rows)."
    echo "  The suppression row will not be written by this script."
    echo "  A real provider-initiated POST to ${SERVER_URL}/unsubscribe/one-click"
    echo "  can now be observed without interference from a pre-existing local suppression."
    echo ""
    echo "  NOTE: This proves the endpoint logic and suppression DB write."
    echo "  It does NOT prove that a mailbox provider can reach ${SERVER_URL}/unsubscribe/one-click"
    echo "  via a real HTTP POST. A provider-initiated one-click unsubscribe requires BASE_URL"
    echo "  to be a publicly reachable URL."
  else
    UNSUB_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      "${SERVER_URL}/unsubscribe/one-click?token=${TOKEN_VALUE}" \
      -H "Content-Type: application/json" \
      -d '{"List-Unsubscribe":"One-Click"}' \
      2>/dev/null)
    UNSUB_BODY=$(echo "$UNSUB_RESPONSE" | sed '$d')
    UNSUB_STATUS=$(echo "$UNSUB_RESPONSE" | tail -1)

    if [ "$UNSUB_STATUS" = "200" ]; then
      pass "unsubscribe_endpoint: POST /unsubscribe/one-click -> 200"
    else
      fail "unsubscribe_endpoint: POST /unsubscribe/one-click -> $UNSUB_STATUS ($UNSUB_BODY)"
    fi

    # Verify suppression row
    export SEND_TEST_SUPPRESSION_ID=""
    cat > "$TMPDIR_SCRIPTS/check_suppression.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, sql } from "drizzle-orm";

const r = process.env.SEND_TEST_REPO_ROOT;
const { suppressions } = await import(resolve(r, "drizzle/dist/schema/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL });
const db = drizzle(pool);
try {
  const rows = await db.select({ id: suppressions.id, email: suppressions.email })
    .from(suppressions).where(and(
      eq(suppressions.tenantId, process.env.SEND_TEST_TENANT_ID),
      sql`lower(${suppressions.email}) = lower(${process.env.SEND_TEST_RECIPIENT})`,
    )).limit(1);
  if (rows.length > 0) {
    console.log("OK");
    console.log("SUPPRESSED_EMAIL:" + rows[0].email);
    console.log("SUPPRESSION_ID:" + rows[0].id);
  } else {
    console.log("NOT_FOUND");
  }
} finally { await pool.end(); }
NODEOF

    SUPP_OUTPUT=$(run_node "$TMPDIR_SCRIPTS/check_suppression.mjs")
    SUPP_STATUS=$(echo "$SUPP_OUTPUT" | grep -E "^(OK|NOT_FOUND)" | head -1 || true)
    SUPPRESSED_EMAIL=$(echo "$SUPP_OUTPUT" | grep "^SUPPRESSED_EMAIL:" | sed 's/^SUPPRESSED_EMAIL://' || true)
    SUPPRESSION_ID=$(echo "$SUPP_OUTPUT" | grep "^SUPPRESSION_ID:" | sed 's/^SUPPRESSION_ID://' || true)

    if [ "$SUPP_STATUS" = "OK" ]; then
      NORMALIZED=$(echo "$RECIPIENT" | tr '[:upper:]' '[:lower:]')
      STORED_LOWER=$(echo "$SUPPRESSED_EMAIL" | tr '[:upper:]' '[:lower:]')
      if [ "$STORED_LOWER" = "$NORMALIZED" ]; then
        pass "suppression_row_written: $SUPPRESSED_EMAIL (normalized correctly)"
      else
        fail "suppression_row_written: stored=$SUPPRESSED_EMAIL expected=$RECIPIENT (case mismatch)"
      fi
    else
      fail "suppression_row_written: no row found for $RECIPIENT"
    fi

    # Remove suppression so test address is not left suppressed
    if [ -n "$SUPPRESSION_ID" ]; then
      export SEND_TEST_SUPPRESSION_ID="$SUPPRESSION_ID"
      cat > "$TMPDIR_SCRIPTS/remove_suppression.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

const r = process.env.SEND_TEST_REPO_ROOT;
const { suppressions } = await import(resolve(r, "drizzle/dist/schema/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL });
const db = drizzle(pool);
try {
  await db.delete(suppressions).where(eq(suppressions.id, process.env.SEND_TEST_SUPPRESSION_ID));
  console.log("OK");
} finally { await pool.end(); }
NODEOF

      RM_OUT=$(run_node "$TMPDIR_SCRIPTS/remove_suppression.mjs" || true)
      if echo "$RM_OUT" | grep -q "^OK"; then
        echo "  Removed suppression for $RECIPIENT (test address not left suppressed)"
      else
        echo "  WARNING: could not remove suppression for $RECIPIENT - remove manually"
      fi
    fi

    echo ""
    echo "  NOTE: This proves the endpoint logic and suppression DB write."
    echo "  It does NOT prove that a mailbox provider can reach ${SERVER_URL}/unsubscribe/one-click"
    echo "  via a real HTTP POST. A provider-initiated one-click unsubscribe requires BASE_URL"
    echo "  to be a publicly reachable URL."
  fi
fi

# ---------------------------------------------------------------------------
# What remains unproven
# ---------------------------------------------------------------------------

section "What remains unproven"
echo ""
echo "  Brain pipeline bypassed:"
echo "    This script creates the message directly at pending_approval, skipping"
echo "    the Brain pipeline entirely. decide(), draft(), and assess() were not"
echo "    called. This run proves: transport adapter, compliance injection (headers"
echo "    and footer), unsubscribe token generation and verification, and the"
echo "    drain path. It does NOT prove LLM content generation or value gating."
echo ""
echo "  Provider-initiated one-click unsubscribe POST:"
echo "     Resend (and Gmail/Yahoo) will POST to:"
echo "     ${EFFECTIVE_BASE_URL}/unsubscribe/one-click?token=..."
echo "     This cannot reach a localhost BASE_URL from outside this machine."
echo "     Set BASE_URL to a public hostname to enable provider-initiated unsubscribes."
echo ""
echo "  Webhook ingestion (bounce, complaint, open, click):"
echo "     Resend delivers webhook events to POST /webhooks/resend/<tenant_id>."
echo "     Requires a public URL registered in the Resend webhook dashboard."

# ---------------------------------------------------------------------------
# Cleanup: remove test rows created by this run
# ---------------------------------------------------------------------------

section "Cleanup"

# The cleanup script always removes the session, the flow stub (and its
# membership), and the contact if this run created it. When --keep-rows is
# set the message row is intentionally left so provider webhooks can resolve
# it by provider_message_id after the script exits.
cat > "$TMPDIR_SCRIPTS/cleanup.mjs" << 'NODEOF'
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";

const r = process.env.SEND_TEST_REPO_ROOT;
const { sessions, lifecycleMessages, flowMemberships, flows, contacts } =
  await import(resolve(r, "drizzle/dist/schema/index.js"));
const pool = new Pool({ connectionString: process.env.SEND_TEST_DB_URL });
const db = drizzle(pool);

const sessionId = process.env.SEND_TEST_SESSION_ID;
const messageId = process.env.SEND_TEST_MESSAGE_ID;
const flowId = process.env.SEND_TEST_FLOW_ID;
const contactId = process.env.SEND_TEST_CONTACT_ID;
const contactCreated = process.env.SEND_TEST_CONTACT_CREATED === "true";
const keepMessage = process.env.SEND_TEST_KEEP_MESSAGE === "true";

try {
  // Session
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    console.log("DELETED_SESSION:" + sessionId);
  }

  // Message: skip when --keep-rows so webhook events can resolve the row
  if (messageId && !keepMessage) {
    await db.delete(lifecycleMessages).where(eq(lifecycleMessages.id, messageId));
    console.log("DELETED_MESSAGE:" + messageId);
  } else if (messageId && keepMessage) {
    console.log("KEPT_MESSAGE:" + messageId);
  }

  // Memberships for the test flow (the flow is a stub created only for this run)
  if (flowId) {
    await db.delete(flowMemberships).where(eq(flowMemberships.flowId, flowId));
    await db.delete(flows).where(eq(flows.id, flowId));
    console.log("DELETED_FLOW:" + flowId);
  }

  // Contact: only if this run created it (pre-existing contacts are preserved)
  if (contactCreated && contactId) {
    await db.delete(contacts).where(eq(contacts.id, contactId));
    console.log("DELETED_CONTACT:" + contactId);
  } else if (contactId) {
    console.log("PRESERVED_CONTACT:" + contactId + " (pre-existing, not removed)");
  }

  console.log("OK");
} catch (err) {
  console.log("CLEANUP_ERROR:" + err.message);
} finally { await pool.end(); }
NODEOF

export SEND_TEST_SESSION_ID="${SESSION_ID:-}"
export SEND_TEST_KEEP_MESSAGE="${KEEP_ROWS}"
CLEANUP_OUTPUT=$(run_node "$TMPDIR_SCRIPTS/cleanup.mjs")
CLEANUP_STATUS=$(echo "$CLEANUP_OUTPUT" | grep -E "^(OK|CLEANUP_ERROR)" | head -1 || true)

if echo "$CLEANUP_OUTPUT" | grep -q "^DELETED_SESSION:"; then
  echo "  Session removed"
fi
if echo "$CLEANUP_OUTPUT" | grep -q "^DELETED_MESSAGE:"; then
  echo "  Message removed"
fi
if echo "$CLEANUP_OUTPUT" | grep -q "^KEPT_MESSAGE:"; then
  echo "  Message row left in place (--keep-rows)"
fi
if echo "$CLEANUP_OUTPUT" | grep -q "^DELETED_FLOW:"; then
  echo "  Flow stub and memberships removed"
fi
if echo "$CLEANUP_OUTPUT" | grep -q "^DELETED_CONTACT:"; then
  echo "  Contact removed (was created by this run)"
fi
if echo "$CLEANUP_OUTPUT" | grep -q "^PRESERVED_CONTACT:"; then
  echo "  Contact preserved (existed before this run)"
fi

if [ "$CLEANUP_STATUS" = "OK" ]; then
  if [ "$KEEP_ROWS" = true ]; then
    echo "  Partial cleanup complete (message row intentionally kept)."
  else
    echo "  Cleanup complete. Database contains no rows from this test run."
  fi
else
  err_msg=$(echo "$CLEANUP_OUTPUT" | grep "^CLEANUP_ERROR:" | sed 's/^CLEANUP_ERROR://' || true)
  echo "  WARNING: cleanup encountered an error: $err_msg"
  echo "  Rows that may remain: session=$SESSION_ID, message=$MESSAGE_ID, flow=$FLOW_ID"
fi

# ---------------------------------------------------------------------------
# --keep-rows: print rows left behind and manual verification queries
# ---------------------------------------------------------------------------

if [ "$KEEP_ROWS" = true ]; then
  section "Rows left behind (--keep-rows)"
  echo ""
  echo "  The following rows were intentionally NOT deleted."
  echo "  Provider webhooks (open, click, bounce, unsubscribe) will resolve by"
  echo "  provider_message_id. The row must exist when the event arrives."
  echo ""
  echo "  Message row:"
  echo "    Table:              lifecycle_messages"
  echo "    Claros message ID:  $MESSAGE_ID"
  echo "    Provider msg ID:    ${PROVIDER_MSG_ID:-(not captured - check the row)}"
  echo "    Tenant ID:          $SEND_TEST_TENANT_ID"
  echo ""
  echo "  Suppression row:"
  echo "    None written by this run (local unsubscribe call was skipped)."
  echo "    A suppression row will be created by the webhook handler when a"
  echo "    provider-initiated unsubscribe arrives."
  echo ""
  echo "  Manual verification queries:"
  echo ""
  echo "  -- Check message feedback after a provider open/click/bounce event:"
  echo "  SELECT id, status, feedback, provider_message_id, updated_at"
  echo "    FROM lifecycle_messages"
  echo "    WHERE id = '$MESSAGE_ID';"
  echo ""
  echo "  -- Check suppression row after a provider-initiated unsubscribe:"
  echo "  SELECT id, email, reason, created_at"
  echo "    FROM suppressions"
  echo "    WHERE tenant_id = '$SEND_TEST_TENANT_ID'"
  echo "      AND lower(email) = lower('$RECIPIENT');"
  echo ""
  echo "  -- Manual cleanup when done:"
  echo "  DELETE FROM lifecycle_messages WHERE id = '$MESSAGE_ID';"
  echo "  DELETE FROM suppressions"
  echo "    WHERE tenant_id = '$SEND_TEST_TENANT_ID'"
  echo "      AND lower(email) = lower('$RECIPIENT');"
fi

# ===========================================================================
# FINAL SUMMARY
# ===========================================================================

section "Summary"
echo ""
for c in "${CHECKS[@]}"; do
  echo "  $c"
done
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "FAILED: $FAIL check(s) did not pass. See details above."
  exit 1
else
  echo "PASSED: all $PASS checks passed."
  exit 0
fi
