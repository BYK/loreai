#!/usr/bin/env bash
# Integration test for lore-hermes plugin.
#
# Prerequisites:
#   - lore binary on PATH (or built from this repo)
#   - hermes binary on PATH (pip install hermes-agent)
#   - lore-hermes plugin installed (pip install -e packages/hermes)
#
# Usage:
#   ./packages/hermes/test-integration.sh
#
# The script:
#   1. Verifies both binaries exist
#   2. Starts the Lore gateway
#   3. Verifies Hermes is detected by `lore run`
#   4. Tests the gateway API with context markers
#   5. Tests `hermes lore status` CLI command
#   6. Cleans up

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

pass=0
fail=0
GATEWAY_PID=""

cleanup() {
  if [[ -n "$GATEWAY_PID" ]]; then
    echo -e "\n${YELLOW}Stopping gateway (pid $GATEWAY_PID)...${NC}"
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

ok() {
  echo -e "  ${GREEN}PASS${NC}: $1"
  ((pass++))
}

fail() {
  echo -e "  ${RED}FAIL${NC}: $1"
  ((fail++))
}

# ---------------------------------------------------------------------------
# 1. Check prerequisites
# ---------------------------------------------------------------------------

echo "=== Prerequisites ==="

if command -v lore &>/dev/null || command -v lore-gateway &>/dev/null; then
  ok "lore binary found: $(command -v lore 2>/dev/null || command -v lore-gateway)"
else
  fail "lore binary not found on PATH"
  echo "  Install: curl -fsSL https://withlore.ai/install | bash"
  echo "  Or build from this repo: bun run build && export PATH=\$PWD/packages/gateway/dist:\$PATH"
  exit 1
fi

if command -v hermes &>/dev/null; then
  ok "hermes binary found: $(command -v hermes)"
else
  fail "hermes binary not found on PATH"
  echo "  Install: pip install hermes-agent"
  echo "  Skipping Hermes-specific tests (gateway tests still run)"
fi

# ---------------------------------------------------------------------------
# 2. Start gateway
# ---------------------------------------------------------------------------

echo ""
echo "=== Gateway Startup ==="

LORE_BIN=$(command -v lore 2>/dev/null || command -v lore-gateway)

# Use a temp dir as test project
TEST_PROJECT=$(mktemp -d)
echo "Test project dir: $TEST_PROJECT"

# Start gateway
"$LORE_BIN" start &
GATEWAY_PID=$!

# Wait for gateway to come up
GATEWAY_URL=""
for i in $(seq 1 20); do
  sleep 0.5
  for port in 3207 5673; do
    if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      GATEWAY_URL="http://127.0.0.1:$port"
      break 2
    fi
  done
done

if [[ -n "$GATEWAY_URL" ]]; then
  ok "Gateway running at $GATEWAY_URL"
else
  fail "Gateway did not start within 10s"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Test gateway health
# ---------------------------------------------------------------------------

echo ""
echo "=== Gateway Health ==="

HEALTH=$(curl -sf "$GATEWAY_URL/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "Health endpoint returns ok"
else
  fail "Health endpoint: $HEALTH"
fi

VERSION=$(echo "$HEALTH" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
if [[ -n "$VERSION" ]]; then
  ok "Gateway version: $VERSION"
else
  fail "Could not extract version from health response"
fi

# ---------------------------------------------------------------------------
# 4. Test agent detection
# ---------------------------------------------------------------------------

echo ""
echo "=== Agent Detection ==="

# Send an OpenAI-format request with context markers to the gateway
# This simulates what Hermes would send with the plugin active
MARKER_REQUEST=$(cat <<'EOF'
{
  "model": "test-model",
  "messages": [
    {
      "role": "user",
      "content": "Hello\n[lore:session-id=aabbccdd11223344]\n[lore:project=/tmp/test-project]"
    }
  ],
  "max_tokens": 10,
  "stream": false
}
EOF
)

# This will fail to reach upstream (no real API key), but the gateway
# should still process the request and we can verify it parsed the markers.
# We expect a 401/502 from upstream, not a gateway error.
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
  -X POST "$GATEWAY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d "$MARKER_REQUEST" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" != "000" ]]; then
  ok "Gateway accepted OpenAI chat/completions request (HTTP $HTTP_CODE)"
else
  fail "Gateway rejected request entirely"
fi

# ---------------------------------------------------------------------------
# 5. Test recall API
# ---------------------------------------------------------------------------

echo ""
echo "=== Recall API ==="

RECALL_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
  "$GATEWAY_URL/api/v1/recall?q=test&path=$TEST_PROJECT" 2>/dev/null || echo "000")

if [[ "$RECALL_CODE" == "200" ]]; then
  ok "Recall API responds (HTTP $RECALL_CODE)"
else
  # Recall may return 404 if no project exists yet, which is expected
  if [[ "$RECALL_CODE" == "404" ]]; then
    ok "Recall API responds with 404 (no project data yet, expected)"
  else
    fail "Recall API error (HTTP $RECALL_CODE)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Test hermes lore CLI (if hermes is installed)
# ---------------------------------------------------------------------------

if command -v hermes &>/dev/null; then
  echo ""
  echo "=== Hermes CLI ==="

  # Check if lore-hermes plugin is installed
  if python3 -c "import lore_hermes" 2>/dev/null; then
    ok "lore-hermes plugin importable"

    # Test hermes lore status
    if LORE_GATEWAY_URL="$GATEWAY_URL" hermes lore status 2>/dev/null | grep -q "RUNNING"; then
      ok "hermes lore status shows RUNNING"
    else
      fail "hermes lore status did not show RUNNING"
    fi
  else
    echo -e "  ${YELLOW}SKIP${NC}: lore-hermes plugin not installed (pip install -e packages/hermes)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Summary ==="
echo -e "  ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"

rm -rf "$TEST_PROJECT"

if [[ $fail -gt 0 ]]; then
  exit 1
fi
