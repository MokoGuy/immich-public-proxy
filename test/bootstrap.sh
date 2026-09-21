#!/usr/bin/env bash
#
# Take a freshly started, empty Immich to the point where the integration
# suites can use it, and print the environment they expect.
#
# Three public API calls, no seeding, no test-only endpoints:
#   1. admin-sign-up  - the first user of an empty instance becomes admin
#   2. login          - exchange that for an access token
#   3. api-keys       - mint a SCOPED key for fixtures only
#
# The key deliberately cannot upload. Guest upload is authorised by the share
# key alone; a suite that smuggled an API key into those requests would prove
# nothing about the feature.
#
#   eval "$(./test/bootstrap.sh)"          # local: emits `export` lines
#   ./test/bootstrap.sh >> "$GITHUB_ENV"   # CI: emits bare KEY=VALUE lines
#
# It picks the right form by looking for GITHUB_ENV, because a bare KEY=VALUE
# fed to eval sets a shell variable that child processes never see - which
# looks exactly like a working bootstrap right up until every test skips.

set -euo pipefail

IMMICH_URL="${IMMICH_URL:-http://127.0.0.1:2283}"
IPP_URL="${IPP_URL:-http://127.0.0.1:3000}"
# Second proxy, slug writes allowed - see test/immich-stack.yml.
IPP_SLUG_URL="${IPP_SLUG_URL:-http://127.0.0.1:3001}"
IPP_REAP_URL="${IPP_REAP_URL:-http://127.0.0.1:3002}"
# Must match ipp.upload.maxFileSizeMb in test/immich-stack.yml.
UPLOAD_MAX_MB="${UPLOAD_MAX_MB:-2}"
# Must match ipp.upload.maxConcurrent in test/immich-stack.yml.
UPLOAD_MAX_CONCURRENT="${UPLOAD_MAX_CONCURRENT:-2}"

EMAIL="e2e@example.test"
PASSWORD="e2e-password-not-a-secret"

log () { echo "bootstrap: $*" >&2; }

wait_for () {
  local name=$1 url=$2 tries=${3:-120}
  for _ in $(seq 1 "$tries"); do
    if [ "$(curl -fsS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = "200" ]; then
      log "$name ready"
      return 0
    fi
    sleep 1
  done
  log "ERROR: $name never became ready at $url"
  return 1
}

wait_for immich "$IMMICH_URL/api/server/ping"
wait_for ipp "$IPP_URL/share/healthcheck"
wait_for ipp-slug "$IPP_SLUG_URL/share/healthcheck"
wait_for ipp-reap "$IPP_REAP_URL/share/healthcheck"

# An empty instance accepts exactly one admin sign-up; a second returns 400,
# which is fine if we are re-running against a stack that is already set up.
if ! curl -fsS -X POST "$IMMICH_URL/api/auth/admin-sign-up" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"E2E\"}" \
      >/dev/null 2>&1; then
  log "admin already exists, continuing"
fi

TOKEN=$(curl -fsS -X POST "$IMMICH_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')

# Exactly the seven permissions the fixtures need: create a throwaway album
# and its shared links, read the album back, delete all of it. Nothing else.
API_KEY=$(curl -fsS -X POST "$IMMICH_URL/api/api-keys" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "ipp-integration",
        "permissions": [
          "album.create", "album.read", "album.delete",
          "sharedLink.create", "sharedLink.delete",
          "asset.read", "asset.delete"
        ]
      }' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])')

log "scoped API key minted"

# Bare assignments for $GITHUB_ENV, `export` for a local eval.
prefix=""
[ -z "${GITHUB_ENV:-}" ] && prefix="export "

cat <<EOF
${prefix}E2E_IMMICH_URL=$IMMICH_URL
${prefix}E2E_IMMICH_API_KEY=$API_KEY
${prefix}E2E_IPP_URL=$IPP_URL
${prefix}E2E_IPP_SLUG_URL=$IPP_SLUG_URL
${prefix}E2E_IPP_REAP_URL=$IPP_REAP_URL
${prefix}E2E_UPLOAD_MAX_MB=$UPLOAD_MAX_MB
${prefix}E2E_UPLOAD_MAX_CONCURRENT=$UPLOAD_MAX_CONCURRENT
EOF
