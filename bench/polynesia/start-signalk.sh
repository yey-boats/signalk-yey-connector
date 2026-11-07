#!/bin/sh
# Install the yey connector into the SignalK config directory, then start the
# server. Runs on every start; reinstalls only when the source changed.
set -eu
cd "${SIGNALK_NODE_CONFIG_DIR:-/home/node/.signalk}"
[ -f settings.json ] || cp /bench/settings.json settings.json
[ -f package.json ] || printf '{"name":"signalk-bench","private":true,"dependencies":{}}\n' > package.json

# First boot only, what an owner would set in the admin UI:
# - read-only access, so the connector can read over REST. ADMINUSER (which the
#   simulator needs, it logs in to write) makes the security config immutable
#   through the API, but allow_readonly is still read from security.json.
# - the connector enabled. Written once, so a paired boat keeps its credential.
[ -f security.json ] || printf '{"allow_readonly": true}\n' > security.json
mkdir -p plugin-config-data
[ -f plugin-config-data/signalk-yey-connector.json ] || printf '%s\n' \
  '{"enabled": true, "enableLogging": false, "configuration": {"signalkUrl": "http://localhost:3000"}}' \
  > plugin-config-data/signalk-yey-connector.json

src="${CONNECTOR_SRC:-release}"
case "$src" in
  release)
    v="${CONNECTOR_VERSION:-0.1.0}"
    url="https://github.com/yey-boats/signalk-yey-connector/releases/download/v${v}/signalk-yey-connector-${v}.tgz"
    id="release-${v}"
    # npm 12 (in current SignalK images) refuses remote tarballs by default
    # (allow-remote=none) but installs local files, so download first.
    spec="/tmp/signalk-yey-connector-${v}.tgz"
    if [ "$(cat node_modules/.bench-connector 2>/dev/null || true)" != "$id" ]; then
      node -e "fetch(process.argv[1]).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);require('fs').writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(e.message);process.exit(1)})" "$url" "$spec"
    fi
    ;;
  local)
    # Pack the mounted checkout so its dependencies install normally.
    spec="$(cd /tmp && npm pack /connector --silent | tail -1)"
    spec="/tmp/${spec}"
    id="local-$(sha256sum "$spec" | cut -c1-16)"
    ;;
  *)
    spec="$src"
    id="spec-$src"
    ;;
esac

marker=node_modules/.bench-connector
if [ "$(cat "$marker" 2>/dev/null || true)" != "$id" ]; then
  echo "[bench] installing signalk-yey-connector from ${spec}"
  npm install --no-audit --no-fund --omit=dev "$spec"
  echo "$id" > "$marker"
else
  echo "[bench] signalk-yey-connector already installed (${id})"
fi

exec /home/node/signalk/startup.sh
