#!/usr/bin/env bash
# Run playwright-mcp on loopback, then run caddy in the foreground (caddy
# enforces the bearer-token gate on :8000).
set -euo pipefail

: "${PLAYWRIGHT_MCP_TOKEN:?PLAYWRIGHT_MCP_TOKEN must be set}"

# Disable upstream's host check (Caddy is the security boundary now).
node /app/cli.js \
	--port 8931 --host 127.0.0.1 \
	--allowed-hosts '*' \
	--headless --browser chromium --no-sandbox &
PWMCP_PID=$!
trap 'kill $PWMCP_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
	if (echo > /dev/tcp/127.0.0.1/8931) 2>/dev/null; then break; fi
	sleep 0.5
done

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
