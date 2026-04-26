#!/usr/bin/env bash
# Build (if needed) and run the Playwright MCP sidecar on the nanoclaw network.
# Idempotent — safe to call from systemd or src/index.ts on every boot.
set -euo pipefail

NETWORK="${NANOCLAW_NETWORK:-nanoclaw}"
IMAGE="${PLAYWRIGHT_MCP_IMAGE:-nanoclaw-playwright-mcp:latest}"
NAME="${PLAYWRIGHT_MCP_NAME:-playwright-mcp}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOKEN_FILE="$PROJECT_ROOT/data/sidecar-tokens/playwright.token"

# Bearer token between agent containers and the sidecar. Lives in its own
# file (mode 0600) instead of .env so it stays out of every agent's env when
# only the sidecars need it.
mkdir -p "$(dirname "$TOKEN_FILE")"
if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$TOKEN_FILE"
  echo "Generated PLAYWRIGHT_MCP_TOKEN at $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
PLAYWRIGHT_MCP_TOKEN="$(<"$TOKEN_FILE")"
TOKEN_HASH="$(printf '%s' "$PLAYWRIGHT_MCP_TOKEN" | sha256sum | cut -c1-12)"

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "Creating docker network $NETWORK"
  docker network create "$NETWORK"
fi

# Build only if image is missing or its source files changed.
SRC_HASH="$(cat "$SCRIPT_DIR"/Dockerfile "$SCRIPT_DIR"/Caddyfile "$SCRIPT_DIR"/entrypoint.sh | sha256sum | cut -c1-12)"
IMAGE_HASH="$(docker image inspect -f '{{ index .Config.Labels "nanoclaw.playwright.src-hash" }}' "$IMAGE" 2>/dev/null || true)"
if [[ "$IMAGE_HASH" != "$SRC_HASH" ]]; then
  echo "Building $IMAGE (src-hash=$SRC_HASH)"
  docker build --label "nanoclaw.playwright.src-hash=$SRC_HASH" -t "$IMAGE" "$SCRIPT_DIR" >/dev/null
fi

RUNNING_IMG="$(docker inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true)"
LATEST_IMG="$(docker inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
RUNNING_TOKEN_HASH="$(docker inspect -f '{{ index .Config.Labels "nanoclaw.playwright.token-hash" }}' "$NAME" 2>/dev/null || true)"
if [[ -n "$RUNNING_IMG" && "$RUNNING_IMG" == "$LATEST_IMG" ]] \
   && [[ "$RUNNING_TOKEN_HASH" == "$TOKEN_HASH" ]] \
   && docker ps --filter "name=^${NAME}$" --filter "status=running" -q | grep -q .; then
  echo "Sidecar already running on latest image; nothing to do."
  exit 0
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "Starting $NAME on network $NETWORK"
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --label "nanoclaw.playwright.token-hash=$TOKEN_HASH" \
  --restart unless-stopped \
  --health-cmd "bash -c '(echo > /dev/tcp/127.0.0.1/8000) && (echo > /dev/tcp/127.0.0.1/8931)'" \
  --health-interval 30s \
  --health-timeout 3s \
  --health-start-period 15s \
  --health-retries 3 \
  -e "PLAYWRIGHT_MCP_TOKEN=$PLAYWRIGHT_MCP_TOKEN" \
  "$IMAGE" >/dev/null

echo "Sidecar running. Tools reachable from network $NETWORK at http://$NAME:8000/mcp"
