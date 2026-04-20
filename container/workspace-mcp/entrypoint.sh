#!/usr/bin/env bash
# Boot the sidecar:
#   1. Trust OneCLI's CA so Python's TLS stack accepts proxy MITM.
#   2. Write a stub credentials file so workspace-mcp starts without ever
#      needing real Google tokens — the OneCLI gateway injects them at
#      request time. Expiry is 2099 so workspace-mcp's own refresh path
#      never fires (and never sees the stub client_id failing).
#   3. Start workspace-mcp on loopback, then run caddy in front of it.
set -euo pipefail

: "${WORKSPACE_MCP_TOKEN:?WORKSPACE_MCP_TOKEN must be set}"
: "${USER_GOOGLE_EMAIL:?USER_GOOGLE_EMAIL must be set}"
: "${ONECLI_URL:?ONECLI_URL must be set}"

# Trust OneCLI's CA so the gateway can MITM workspace-mcp's outbound HTTPS
# and inject real OAuth tokens. Three sinks need to know about it:
#   - certifi's bundle: used by httplib2 (which google-api-python-client uses)
#   - REQUESTS_CA_BUNDLE: used by `requests` / `google-auth`'s refresh path
#   - SSL_CERT_FILE: stdlib `ssl` fallback
ONECLI_CA=/tmp/onecli-ca.pem
curl -sSf "${ONECLI_URL}/api/gateway/ca" -o "$ONECLI_CA"
CERTIFI_BUNDLE="$(uv tool run --from workspace-mcp python3 -c 'import certifi; print(certifi.where())')"
cat "$ONECLI_CA" >> "$CERTIFI_BUNDLE"
export REQUESTS_CA_BUNDLE="$CERTIFI_BUNDLE" SSL_CERT_FILE="$CERTIFI_BUNDLE"

# Stub credentials — token never used (proxy rewrites Authorization header),
# expiry far enough out that workspace-mcp's refresh check never trips.
STUB="${WORKSPACE_MCP_CREDENTIALS_DIR}/${USER_GOOGLE_EMAIL}.json"
cat > "$STUB" <<EOF
{
  "token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_uri": "https://oauth2.googleapis.com/token",
  "client_id": "onecli-managed",
  "client_secret": "onecli-managed",
  "scopes": [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events"
  ],
  "expiry": "2099-12-31T23:59:59"
}
EOF
chmod 600 "$STUB"

# workspace-mcp listens on loopback only; caddy reverse-proxies to it.
export WORKSPACE_MCP_HOST=127.0.0.1
export WORKSPACE_MCP_PORT=8001

workspace-mcp \
	--single-user \
	--transport streamable-http \
	--permissions gmail:readonly calendar:full &
WMCP_PID=$!

trap 'kill $WMCP_PID 2>/dev/null || true' EXIT

# Wait briefly for workspace-mcp to bind before caddy accepts traffic.
for _ in $(seq 1 30); do
	if (echo > /dev/tcp/127.0.0.1/8001) 2>/dev/null; then break; fi
	sleep 0.5
done

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
