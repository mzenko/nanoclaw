#!/usr/bin/env bash
# Build (if needed) and run the workspace-mcp sidecar on the nanoclaw network.
# Idempotent — safe to call from systemd or src/index.ts on every boot.
set -euo pipefail

NETWORK="${NANOCLAW_NETWORK:-nanoclaw}"
IMAGE="${WORKSPACE_MCP_IMAGE:-nanoclaw-workspace-mcp:latest}"
NAME="${WORKSPACE_MCP_NAME:-workspace-mcp}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
TOKEN_FILE="$PROJECT_ROOT/data/sidecar-tokens/workspace.token"

if [[ -f "$ENV_FILE" ]]; then
  set -a; . "$ENV_FILE"; set +a
fi

: "${USER_GOOGLE_EMAIL:?USER_GOOGLE_EMAIL must be set in .env}"
: "${ONECLI_URL:?ONECLI_URL must be set in .env}"
command -v jq >/dev/null || { echo "jq is required (used to parse onecli output)" >&2; exit 1; }

# --- bearer token between agent containers and the sidecar --------
# Lives in its own file (mode 0600) instead of .env so it stays out of every
# agent's env when only the sidecars need it.
mkdir -p "$(dirname "$TOKEN_FILE")"
if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$TOKEN_FILE"
  echo "Generated WORKSPACE_MCP_TOKEN at $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
WORKSPACE_MCP_TOKEN="$(<"$TOKEN_FILE")"
TOKEN_HASH="$(printf '%s' "$WORKSPACE_MCP_TOKEN" | sha256sum | cut -c1-12)"

# --- OneCLI proxy URL for outbound Google traffic ------------------
# Fetch the default agent's token fresh each run so a regenerate-token
# in OneCLI is picked up automatically.
AGENT_TOKEN="$(onecli agents get-default | jq -r '.accessToken')"
PROXY_HOST="$(echo "$ONECLI_URL" | sed -E 's|https?://([^:/]+).*|\1|')"
HTTPS_PROXY_URL="http://x:${AGENT_TOKEN}@${PROXY_HOST}:10255"

# --- network + image ----------------------------------------------
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "Creating docker network $NETWORK"
  docker network create "$NETWORK"
fi

# Build only if the image is missing or its source files have changed since
# the last build. Steady-state boots skip the build entirely.
SRC_HASH="$(cat "$SCRIPT_DIR"/Dockerfile "$SCRIPT_DIR"/Caddyfile "$SCRIPT_DIR"/entrypoint.sh "$SCRIPT_DIR"/client_secret.stub.json | sha256sum | cut -c1-12)"
IMAGE_HASH="$(docker image inspect -f '{{ index .Config.Labels "nanoclaw.workspace.src-hash" }}' "$IMAGE" 2>/dev/null || true)"
if [[ "$IMAGE_HASH" != "$SRC_HASH" ]]; then
  echo "Building $IMAGE (src-hash=$SRC_HASH)"
  docker build --label "nanoclaw.workspace.src-hash=$SRC_HASH" -t "$IMAGE" "$SCRIPT_DIR" >/dev/null
fi

# --- (re)launch ----------------------------------------------------
RUNNING_IMG="$(docker inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true)"
LATEST_IMG="$(docker inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
RUNNING_TOKEN_HASH="$(docker inspect -f '{{ index .Config.Labels "nanoclaw.workspace.token-hash" }}' "$NAME" 2>/dev/null || true)"
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
  --label "nanoclaw.workspace.token-hash=$TOKEN_HASH" \
  --add-host=host.docker.internal:host-gateway \
  --restart unless-stopped \
  --health-cmd "bash -c '(echo > /dev/tcp/127.0.0.1/8000) && (echo > /dev/tcp/127.0.0.1/8001)'" \
  --health-interval 30s \
  --health-timeout 3s \
  --health-start-period 10s \
  --health-retries 3 \
  -e "USER_GOOGLE_EMAIL=$USER_GOOGLE_EMAIL" \
  -e "WORKSPACE_MCP_TOKEN=$WORKSPACE_MCP_TOKEN" \
  -e "ONECLI_URL=$ONECLI_URL" \
  -e "HTTPS_PROXY=$HTTPS_PROXY_URL" \
  -e "https_proxy=$HTTPS_PROXY_URL" \
  -e "NO_PROXY=localhost,127.0.0.1" \
  "$IMAGE" >/dev/null

echo "Sidecar running. Tools reachable from network $NETWORK at http://$NAME:8000/mcp"
