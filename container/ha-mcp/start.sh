#!/usr/bin/env bash
# Build (if needed) and run the ha-mcp sidecar on the nanoclaw network.
# Idempotent — safe to call from systemd or src/index.ts on every boot.
set -euo pipefail

NETWORK="${NANOCLAW_NETWORK:-nanoclaw}"
IMAGE="${HA_MCP_IMAGE:-nanoclaw-ha-mcp:latest}"
NAME="${HA_MCP_NAME:-ha-mcp}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a; . "$ENV_FILE"; set +a
fi

: "${HOMEASSISTANT_URL:?HOMEASSISTANT_URL must be set in .env}"
: "${HOMEASSISTANT_TOKEN:?HOMEASSISTANT_TOKEN must be set in .env}"

if ! grep -q '^HA_MCP_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  HA_MCP_TOKEN="$(openssl rand -hex 32)"
  printf '\nHA_MCP_TOKEN=%s\n' "$HA_MCP_TOKEN" >> "$ENV_FILE"
  echo "Generated HA_MCP_TOKEN, persisted to .env"
fi

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "Creating docker network $NETWORK"
  docker network create "$NETWORK"
fi

# Build only if image is missing or its source files changed.
SRC_HASH="$(cat "$SCRIPT_DIR"/Dockerfile "$SCRIPT_DIR"/Caddyfile "$SCRIPT_DIR"/entrypoint.sh "$SCRIPT_DIR"/fastmcp-http.json | sha256sum | cut -c1-12)"
IMAGE_HASH="$(docker image inspect -f '{{ index .Config.Labels "nanoclaw.ha.src-hash" }}' "$IMAGE" 2>/dev/null || true)"
if [[ "$IMAGE_HASH" != "$SRC_HASH" ]]; then
  echo "Building $IMAGE (src-hash=$SRC_HASH)"
  docker build --label "nanoclaw.ha.src-hash=$SRC_HASH" -t "$IMAGE" "$SCRIPT_DIR" >/dev/null
fi

RUNNING_IMG="$(docker inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true)"
LATEST_IMG="$(docker inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
if [[ -n "$RUNNING_IMG" && "$RUNNING_IMG" == "$LATEST_IMG" ]] \
   && docker ps --filter "name=^${NAME}$" --filter "status=running" -q | grep -q .; then
  echo "Sidecar already running on latest image; nothing to do."
  exit 0
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "Starting $NAME on network $NETWORK"
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  --health-cmd "bash -c '(echo > /dev/tcp/127.0.0.1/8000) && (echo > /dev/tcp/127.0.0.1/8086)'" \
  --health-interval 30s \
  --health-timeout 3s \
  --health-start-period 15s \
  --health-retries 3 \
  -e "HA_MCP_TOKEN=$HA_MCP_TOKEN" \
  -e "HOMEASSISTANT_URL=$HOMEASSISTANT_URL" \
  -e "HOMEASSISTANT_TOKEN=$HOMEASSISTANT_TOKEN" \
  "$IMAGE" >/dev/null

echo "Sidecar running. Tools reachable from network $NETWORK at http://$NAME:8000/mcp"
