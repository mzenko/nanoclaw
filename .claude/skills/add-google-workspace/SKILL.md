# Add Google Workspace Integration

Adds Gmail (read-only) and Google Calendar (read/write) tools to NanoClaw via the
`taylorwilsdon/google_workspace_mcp` server, deployed as a long-lived sidecar
container that reaches Google through the OneCLI gateway. No GCP OAuth secrets
ever live on disk inside or outside the container.

## Architecture

- **Sidecar container** (`nanoclaw-workspace-mcp:latest`) runs on a private
  Docker network (`nanoclaw`). Caddy in front of `workspace-mcp` enforces
  bearer-token auth on every MCP request.
- **Per-group agent containers** join the same network and reach the sidecar at
  `http://workspace-mcp:8000/mcp` with `Authorization: Bearer $WORKSPACE_MCP_TOKEN`.
- **OAuth credentials are managed by OneCLI**, not files on disk. The sidecar
  routes its outbound HTTPS through the OneCLI gateway (`HTTPS_PROXY`) and
  trusts the OneCLI CA. The gateway intercepts each Google API call and
  swaps in a real, fresh OAuth token. The sidecar's own credential file is
  a stub with `expiry: 2099-12-31` so workspace-mcp's refresh path never
  fires (and never sees the stub `client_id` failing).

## Phase 1: Pre-flight

Check if already applied:

```bash
ls container/workspace-mcp/ 2>/dev/null && echo "applied" || echo "needs install"
```

If applied, skip to Phase 3.

## Phase 2: Apply code changes

```bash
git remote add google-workspace https://github.com/mzenko/nanoclaw-google-workspace.git
git fetch google-workspace main
git merge google-workspace/main
npm install && npm run build
```

This brings in:
- `container/workspace-mcp/{Dockerfile,Caddyfile,entrypoint.sh,start.sh,client_secret.stub.json}`
- `mcpServers.workspace` HTTP entry in `container/agent-runner/src/index.ts`.
- `--network nanoclaw` and bearer-token pass-through in
  `src/container-runner.ts`.
- `WORKSPACE_MCP_TOKEN` config export and idempotent sidecar auto-start hook
  in `src/index.ts`.

## Phase 3: Setup

### OneCLI app configuration

OneCLI must be running and reachable. You also need a GCP OAuth client of type
"Desktop app" (or any client with `http://127.0.0.1:<port>` registered as a
redirect URI). If you don't have one:

1. https://console.cloud.google.com → new project (or pick existing)
2. APIs & Services → Library → enable **Gmail API** and **Google Calendar API**
3. APIs & Services → Credentials → Create credentials → OAuth client ID →
   **Desktop app**
4. Note the client ID + secret

Register the apps with OneCLI (these credentials never reach the sidecar):

```bash
onecli apps configure --provider gmail \
  --client-id     "<gcp-client-id>" \
  --client-secret "<gcp-client-secret>"
onecli apps configure --provider google-calendar \
  --client-id     "<gcp-client-id>" \
  --client-secret "<gcp-client-secret>"
```

Open these URLs in a browser and complete consent for each:

- `http://127.0.0.1:10254/connections?connect=gmail`
- `http://127.0.0.1:10254/connections?connect=google-calendar`

> If your OneCLI dashboard isn't reachable on `127.0.0.1`, edit
> `~/.onecli/docker-compose.yml` to bind the `onecli` service on `127.0.0.1`
> and re-run `docker compose up -d` in `~/.onecli/`. Google rejects OAuth
> redirects to private IPs (RFC 1918), so loopback is required.

Verify both connections are live:

```bash
onecli apps get --provider gmail | grep -q '"status": "connected"' && echo gmail OK
onecli apps get --provider google-calendar | grep -q '"status": "connected"' && echo calendar OK
```

### Required `.env` entries

```bash
USER_GOOGLE_EMAIL=you@example.com
ONECLI_URL=http://172.17.0.1:10254
```

`WORKSPACE_MCP_TOKEN` is generated automatically on first run of `start.sh`.
No `GOOGLE_OAUTH_CLIENT_ID/SECRET` in `.env` — OneCLI holds them.

### First boot

`start.sh` is idempotent and the nanoclaw service invokes it automatically at
startup. To run it manually the first time:

```bash
bash container/workspace-mcp/start.sh
```

This will:
- Generate `WORKSPACE_MCP_TOKEN` and persist to `.env` (only on first run).
- Build the sidecar image (pinned `workspace-mcp` version + a `pysocks`
  patch — see "Known patches" below).
- Launch the sidecar with `--restart unless-stopped`, configured to route
  outbound HTTPS through the OneCLI gateway.

## Phase 4: Verify

```bash
docker logs workspace-mcp 2>&1 | tail -5    # should show "Uvicorn running"
TOKEN=$(grep '^WORKSPACE_MCP_TOKEN=' .env | cut -d= -f2)
SID=$(docker run --rm --network nanoclaw curlimages/curl:latest -sN -i \
  -X POST http://workspace-mcp:8000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | grep -i '^mcp-session-id' | awk '{print $2}' | tr -d '\r')
docker run --rm --network nanoclaw curlimages/curl:latest -sN -X POST http://workspace-mcp:8000/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Mcp-Session-Id: $SID" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
docker run --rm --network nanoclaw curlimages/curl:latest -sN -X POST http://workspace-mcp:8000/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Mcp-Session-Id: $SID" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_gmail_labels","arguments":{"user_google_email":"you@example.com"}}}' \
  | head -3
docker logs --since 30s onecli | grep injections_applied | tail -1
```

A successful run prints real Gmail labels and an `injections_applied=1` line
in the OneCLI log.

Then ask the assistant in any registered chat: `list my Gmail labels`.

## Removal

```bash
docker rm -f workspace-mcp
docker rmi nanoclaw-workspace-mcp:latest
docker network rm nanoclaw   # only if no other groups use it
onecli apps remove --provider gmail
onecli apps remove --provider google-calendar
git revert <merge-commit> -m 1
```

## Permission scope

Hardcoded in `container/workspace-mcp/entrypoint.sh`:

```
--permissions gmail:readonly calendar:full
```

To narrow or widen, edit the entrypoint and rebuild
(`bash container/workspace-mcp/start.sh` rebuilds + relaunches).

## Known patches

The Dockerfile applies one `sed` to upstream `pysocks` because it sends
`Proxy-Authorization: basic …` (lowercase) and OneCLI's gateway does a
case-sensitive `strip_prefix("Basic ")` when extracting the agent token.
Without the patch, the gateway falls back to tunnel mode and bypasses
credential injection. Remove the `sed` line from `Dockerfile` once OneCLI's
parser is made case-insensitive (per RFC 7617).
