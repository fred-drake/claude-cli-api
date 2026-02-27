#!/usr/bin/env bash
#
# E2E integration tests for claude-cli-api
# Hits real OpenAI/DeepSeek endpoints — costs real money.
#
# Usage: pnpm test:e2e
#
# Env vars: OPENAI_KEY, ANTHROPIC_KEY, DEEPSEEK_KEY
# (These are distinct from OPENAI_API_KEY/ANTHROPIC_API_KEY to avoid
# accidentally inheriting a dev shell's server-facing env vars.)
#
set -euo pipefail

# ── Cost warning ──────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  E2E Integration Tests — LIVE API CALLS"
echo "  This will incur real API charges."
echo "=========================================="
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────
fail_prereq() { echo "PREREQ FAIL: $1" >&2; exit 2; }

[ -n "${OPENAI_KEY:-}" ]    || fail_prereq "OPENAI_KEY is not set"
[ -n "${ANTHROPIC_KEY:-}" ] || fail_prereq "ANTHROPIC_KEY is not set"
[ -n "${DEEPSEEK_KEY:-}" ]  || fail_prereq "DEEPSEEK_KEY is not set"
command -v claude >/dev/null || fail_prereq "claude is not on PATH"
command -v jq     >/dev/null || fail_prereq "jq is not on PATH"
command -v curl   >/dev/null || fail_prereq "curl is not on PATH"

# ── Globals ───────────────────────────────────────────────────────────
PORT=$(( RANDOM % 10000 + 20000 ))
BASE="http://127.0.0.1:${PORT}"
SERVER_PID=""
PASS_COUNT=0
FAIL_COUNT=0
TMPFILES=()

# Response globals set by do_request
RESP_STATUS=""
RESP_HEADERS=""
RESP_BODY=""

# ── Helpers ───────────────────────────────────────────────────────────

cleanup() {
  stop_server
  rm -f "${TMPFILES[@]}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

start_server() {
  # Usage: start_server ENV1=val1 ENV2=val2 ...
  # Unsets server-facing API vars first to prevent leakage between groups.
  local env_args=("$@")
  env_args+=(PORT="$PORT" LOG_LEVEL=warn)

  env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u ANTHROPIC_API_KEY \
    "${env_args[@]}" npx tsx src/index.ts &
  SERVER_PID=$!

  # Poll /health for readiness (15s timeout)
  local deadline=$(( SECONDS + 15 ))
  while (( SECONDS < deadline )); do
    if curl -sf "${BASE}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.3
  done
  echo "FAIL: Server did not become ready within 15s" >&2
  stop_server
  exit 1
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    # Give 5s for graceful shutdown, then SIGKILL
    local i=0
    while kill -0 "$SERVER_PID" 2>/dev/null && (( i < 50 )); do
      sleep 0.1
      (( i++ )) || true
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    # Also kill any child processes (npx -> tsx -> node)
    pkill -P "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

do_request() {
  # Usage: do_request METHOD URL [extra-curl-args...]
  local method="$1" url="$2"
  shift 2

  local tmpfile hdrfile
  tmpfile=$(mktemp)
  hdrfile="${tmpfile}.headers"
  TMPFILES+=("$tmpfile" "$hdrfile")

  RESP_STATUS=$(curl -s -o "$tmpfile" -w '%{http_code}' \
    --max-time 30 \
    -X "$method" \
    -D "$hdrfile" \
    "$@" \
    "${BASE}${url}" 2>/dev/null) || true

  RESP_BODY=$(cat "$tmpfile")
  RESP_HEADERS=$(cat "$hdrfile")
  rm -f "$tmpfile" "$hdrfile"
}

run_test() {
  local name="$1"
  local test_fn="$2"

  if "$test_fn"; then
    echo "  PASS: ${name}"
    (( PASS_COUNT++ )) || true
  else
    echo "  FAIL: ${name}"
    (( FAIL_COUNT++ )) || true
  fi
}

# ── Assertion helpers ─────────────────────────────────────────────────

assert_status() {
  local expected="$1"
  if [ "$RESP_STATUS" != "$expected" ]; then
    echo "    Expected status ${expected}, got ${RESP_STATUS}" >&2
    return 1
  fi
}

assert_json() {
  # Usage: assert_json '.path.to.field' 'expected_value'
  local jq_expr="$1" expected="$2"
  local actual
  actual=$(echo "$RESP_BODY" | jq -r "$jq_expr" 2>/dev/null) || {
    echo "    jq failed on: ${jq_expr}" >&2
    return 1
  }
  if [ "$actual" != "$expected" ]; then
    echo "    Expected ${jq_expr} = '${expected}', got '${actual}'" >&2
    return 1
  fi
}

assert_json_exists() {
  # Usage: assert_json_exists '.path.to.field'
  # Fails if null or missing
  local jq_expr="$1"
  echo "$RESP_BODY" | jq -e "$jq_expr" >/dev/null 2>&1 || {
    echo "    Expected ${jq_expr} to exist and be non-null" >&2
    return 1
  }
}

assert_header() {
  # Usage: assert_header "Header-Name" "expected-value"
  local header="$1" expected="$2"
  local actual
  actual=$(echo "$RESP_HEADERS" | grep -i "^${header}:" | head -1 | sed 's/^[^:]*: *//' | tr -d '\r')
  if [ "$actual" != "$expected" ]; then
    echo "    Expected header ${header}: '${expected}', got '${actual}'" >&2
    return 1
  fi
}

assert_header_present() {
  # Usage: assert_header_present "Header-Name"
  local header="$1"
  echo "$RESP_HEADERS" | grep -qi "^${header}:" || {
    echo "    Expected header ${header} to be present" >&2
    return 1
  }
}

# ── Chat request helpers ──────────────────────────────────────────────

chat_request() {
  # Usage: chat_request model message [extra-curl-args...]
  local model="$1" message="$2"
  shift 2
  local payload
  payload=$(jq -n --arg m "$model" --arg msg "$message" \
    '{model: $m, messages: [{role: "user", content: $msg}]}')
  do_request POST /v1/chat/completions \
    -H "Content-Type: application/json" \
    "$@" \
    -d "$payload"
}

stream_request() {
  # Usage: stream_request model message [extra-curl-args...]
  # Sets RESP_BODY to raw SSE output, RESP_STATUS to HTTP status
  local model="$1" message="$2"
  shift 2

  local payload
  payload=$(jq -n --arg m "$model" --arg msg "$message" \
    '{model: $m, messages: [{role: "user", content: $msg}], stream: true}')

  local tmpfile hdrfile
  tmpfile=$(mktemp)
  hdrfile="${tmpfile}.headers"
  TMPFILES+=("$tmpfile" "$hdrfile")

  RESP_STATUS=$(curl -sN -o "$tmpfile" -w '%{http_code}' \
    --max-time 30 \
    -H "Content-Type: application/json" \
    -D "$hdrfile" \
    "$@" \
    -d "$payload" \
    "${BASE}/v1/chat/completions" 2>/dev/null) || true

  RESP_BODY=$(cat "$tmpfile")
  RESP_HEADERS=$(cat "$hdrfile")
  rm -f "$tmpfile" "$hdrfile"
}

# ======================================================================
# GROUP 1: OpenAI Passthrough
# ======================================================================
echo "--- Group 1: OpenAI Passthrough ---"
start_server \
  OPENAI_API_KEY="$OPENAI_KEY" \
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY"

# Test 1: Health returns 200 with status: "ready"
test_health() {
  do_request GET /health
  assert_status 200 && assert_json '.status' 'ready'
}
run_test "Health returns 200 with status ready" test_health

# Test 2: GET /v1/models returns 3 models
test_models() {
  do_request GET /v1/models
  assert_status 200 || return 1
  local count
  count=$(echo "$RESP_BODY" | jq '.data | length')
  if [ "$count" != "3" ]; then
    echo "    Expected 3 models, got ${count}" >&2
    return 1
  fi
}
run_test "GET /v1/models returns 3 models" test_models

# Test 3: OpenAI non-streaming
test_openai_nonstreaming() {
  chat_request "gpt-4o-mini" "Say hi in exactly 3 words"
  assert_status 200 || return 1
  assert_json_exists '.choices[0].message.content'
}
run_test "OpenAI non-streaming returns content" test_openai_nonstreaming

# Test 4: OpenAI streaming
test_openai_streaming() {
  stream_request "gpt-4o-mini" "Say hi in exactly 3 words"
  assert_status 200 || return 1
  # Check SSE format: must contain data: lines and end with data: [DONE]
  echo "$RESP_BODY" | grep -q '^data: {' || {
    echo "    No SSE data lines found" >&2
    return 1
  }
  echo "$RESP_BODY" | grep -q '^data: \[DONE\]' || {
    echo "    Missing data: [DONE] terminator" >&2
    return 1
  }
}
run_test "OpenAI streaming SSE format with [DONE]" test_openai_streaming

# Test 5: Security headers present
test_security_headers() {
  do_request GET /health
  assert_header_present "X-Content-Type-Options" || return 1
  assert_header "X-Content-Type-Options" "nosniff" || return 1
  assert_header "X-Frame-Options" "DENY" || return 1
  assert_header_present "Content-Security-Policy" || return 1
  assert_header "Referrer-Policy" "no-referrer" || return 1
  assert_header_present "Cache-Control" || return 1
}
run_test "Security headers present" test_security_headers

# Test 6: X-Request-ID echoed back
test_request_id() {
  do_request GET /health -H "X-Request-ID: e2e-test-12345"
  assert_header "X-Request-ID" "e2e-test-12345"
}
run_test "X-Request-ID echoed back" test_request_id

# Test 7: Missing model returns 400
test_missing_model() {
  do_request POST /v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hi"}]}'
  assert_status 400
}
run_test "Missing model returns 400" test_missing_model

# Test 8: Missing messages returns 400
test_missing_messages() {
  do_request POST /v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini"}'
  assert_status 400
}
run_test "Missing messages returns 400" test_missing_messages

stop_server

# ======================================================================
# GROUP 2: DeepSeek Passthrough
# ======================================================================
echo ""
echo "--- Group 2: DeepSeek Passthrough ---"
start_server \
  OPENAI_API_KEY="$DEEPSEEK_KEY" \
  OPENAI_BASE_URL="https://api.deepseek.com/v1" \
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY"

# Test 9: DeepSeek non-streaming
test_deepseek_nonstreaming() {
  chat_request "deepseek-chat" "Say hi in exactly 3 words"
  assert_status 200 || return 1
  assert_json_exists '.choices[0].message.content'
}
run_test "DeepSeek non-streaming returns content" test_deepseek_nonstreaming

# Test 10: DeepSeek streaming
test_deepseek_streaming() {
  stream_request "deepseek-chat" "Say hi in exactly 3 words"
  assert_status 200 || return 1
  echo "$RESP_BODY" | grep -q '^data: {' || {
    echo "    No SSE data lines found" >&2
    return 1
  }
  echo "$RESP_BODY" | grep -q '^data: \[DONE\]' || {
    echo "    Missing data: [DONE] terminator" >&2
    return 1
  }
}
run_test "DeepSeek streaming SSE format with [DONE]" test_deepseek_streaming

stop_server

# ======================================================================
# GROUP 3: Client-Provided Key
# ======================================================================
echo ""
echo "--- Group 3: Client-Provided Key ---"
start_server \
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY"

# Test 11: Client key via X-OpenAI-API-Key header
test_client_key() {
  chat_request "gpt-4o-mini" "Say ok" -H "X-OpenAI-API-Key: ${OPENAI_KEY}"
  assert_status 200 || return 1
  assert_json_exists '.choices[0].message.content'
}
run_test "Client key via X-OpenAI-API-Key returns content" test_client_key

stop_server

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
echo "=========================================="

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
