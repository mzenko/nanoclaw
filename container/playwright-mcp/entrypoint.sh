#!/usr/bin/env bash
# Run Playwright MCP on loopback, then run caddy in the foreground.
set -euo pipefail

: "${PLAYWRIGHT_MCP_TOKEN:?PLAYWRIGHT_MCP_TOKEN must be set}"

mkdir -p /tmp/playwright-mcp

node /app/cli.js \
	--headless \
	--browser chromium \
	--no-sandbox \
	--isolated \
	--image-responses allow \
	--output-dir /tmp/playwright-mcp \
	--port 8931 \
	--host 127.0.0.1 &
PW_MCP_PID=$!

trap 'kill $PW_MCP_PID 2>/dev/null || true' EXIT

# Wait briefly for Playwright MCP to bind before caddy accepts traffic.
for _ in $(seq 1 30); do
	if (echo > /dev/tcp/127.0.0.1/8931) 2>/dev/null; then break; fi
	sleep 0.5
done

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
