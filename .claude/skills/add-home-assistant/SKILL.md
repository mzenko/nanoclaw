# Add Home Assistant Integration

Adds `homeassistant-ai/ha-mcp` as a long-lived Docker sidecar so Chesterbot
can read sensors, control entities, and trigger automations on your Home
Assistant instance.

## Architecture

- **Sidecar container** (`nanoclaw-ha-mcp:latest`) layers Caddy on top of
  `ghcr.io/homeassistant-ai/ha-mcp:latest`. Caddy enforces a bearer-token
  gate; ha-mcp listens on loopback only.
- **Per-group agent containers** join `nanoclaw` and reach the sidecar at
  `http://ha-mcp:8000/mcp` with `Authorization: Bearer $HA_MCP_TOKEN`.
- **HA token** lives in `.env` and is passed to the sidecar at boot. The
  sidecar talks to your HA instance directly over the LAN.

## Phase 1: Pre-flight

```bash
ls container/ha-mcp/ 2>/dev/null && echo "applied" || echo "needs install"
```

## Phase 2: Apply code

```bash
git remote add home-assistant https://github.com/mzenko/nanoclaw-home-assistant.git
git fetch home-assistant main
git merge home-assistant/main
npm install && npm run build
```

## Phase 3: Configure

Generate a long-lived access token in HA: **Profile → Security → Long-lived
access tokens → Create token**.

Add to `.env`:

```bash
HOMEASSISTANT_URL=http://<ha-host>:8123
HOMEASSISTANT_TOKEN=<token>
```

`HA_MCP_TOKEN` is generated automatically on first run.

## Phase 4: First boot

```bash
bash container/ha-mcp/start.sh
```

Or restart nanoclaw — `ensureSidecar('ha-mcp')` runs at boot.

## Phase 5: Verify

```bash
docker ps --filter name=ha-mcp --format '{{.Status}}'
# expect: Up <time> (healthy)
```

Then ask the assistant in any registered chat: `what's the temperature in my office`.

## Removal

```bash
docker rm -f ha-mcp
docker rmi nanoclaw-ha-mcp:latest
git revert <merge-commit> -m 1
```
