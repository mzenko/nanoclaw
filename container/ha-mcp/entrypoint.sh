#!/usr/bin/env bash
# Run ha-mcp on loopback, then run caddy in the foreground (caddy enforces
# the bearer-token gate on :8000).
set -euo pipefail

: "${HA_MCP_TOKEN:?HA_MCP_TOKEN must be set}"
: "${HOMEASSISTANT_URL:?HOMEASSISTANT_URL must be set}"
: "${HOMEASSISTANT_TOKEN:?HOMEASSISTANT_TOKEN must be set}"

fastmcp run /app/fastmcp-http.json &
HAMCP_PID=$!
trap 'kill $HAMCP_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
	if (echo > /dev/tcp/127.0.0.1/8086) 2>/dev/null; then break; fi
	sleep 0.5
done

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
