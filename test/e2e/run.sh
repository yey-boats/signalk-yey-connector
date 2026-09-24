#!/usr/bin/env bash
# Bring the stack up, wait for the simulator's first full frame, run the suite,
# tear down. Leaves the stack running with KEEP=1.
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE=(docker compose -f docker-compose.yml)

"${COMPOSE[@]}" up -d
export SIGNALK_E2E_URL=${SIGNALK_E2E_URL:-http://localhost:3100}

cleanup () {
  [ "${KEEP:-0}" = 1 ] && return
  "${COMPOSE[@]}" down -v >/dev/null
  rm -f signalk-config/security.json
  git checkout -- signalk-config 2>/dev/null || true
}
trap cleanup EXIT

# The same login the simulator does. If this fails, that is the harness (ADMINUSER),
# not the connector.
for _ in $(seq 1 30); do
  SIGNALK_E2E_TOKEN=$(curl -s -X POST "$SIGNALK_E2E_URL/signalk/v1/auth/login" \
    -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}' \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token||'')}catch{}})") || true
  [ -n "$SIGNALK_E2E_TOKEN" ] && break
  sleep 2
done
[ -n "${SIGNALK_E2E_TOKEN:-}" ] || { echo "login failed — is ADMINUSER provisioned?"; exit 1; }
export SIGNALK_E2E_TOKEN

# The simulator needs a first full frame before meta exists. It crash-loops if it
# cannot log in, so a timeout here means: read its logs.
for i in $(seq 1 60); do
  curl -sf -H "Authorization: Bearer $SIGNALK_E2E_TOKEN" \
    "$SIGNALK_E2E_URL/signalk/v1/api/vessels/self/navigation/position" >/dev/null && break
  if [ "$i" = 60 ]; then "${COMPOSE[@]}" logs boat-sim | tail -30; echo "boat-sim never published a position"; exit 1; fi
  sleep 2
done
sleep 20   # let the metadata trickle land

cd ../..
npm run test:e2e
