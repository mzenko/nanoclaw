# Add Playwright Browser Automation

Adds Microsoft's `@playwright/mcp` server as a long-lived Docker sidecar.
Chesterbot can navigate the web, fill forms, click through multi-step flows,
take screenshots, scrape JS-heavy pages — anything the existing
`agent-browser` skill can't do well.

## Architecture

- **Sidecar container** (`nanoclaw-playwright-mcp:latest`) layers Caddy on top
  of `mcr.microsoft.com/playwright/mcp:latest`. Caddy enforces a bearer-token
  gate; Playwright MCP listens on loopback only.
- **Per-group agent containers** join the `nanoclaw` Docker network and reach
  the sidecar at `http://playwright-mcp:8000/mcp` with
  `Authorization: Bearer $PLAYWRIGHT_MCP_TOKEN`.
- **Browsers (Chromium)** are baked into Microsoft's base image — no host
  install needed.

## Phase 1: Pre-flight

Check if already applied:

```bash
ls container/playwright-mcp/ 2>/dev/null && echo "applied" || echo "needs install"
```

## Phase 2: Apply code changes

```bash
git remote add playwright https://github.com/mzenko/nanoclaw-playwright.git
git fetch playwright main
git merge playwright/main
npm install && npm run build
```

This brings in:

- `container/playwright-mcp/{Dockerfile,Caddyfile,entrypoint.sh,start.sh}`
- `mcpServers.playwright` HTTP entry + `mcp__playwright__*` allowed tool in
  `container/agent-runner/src/index.ts`
- `PLAYWRIGHT_MCP_TOKEN` config export and pass-through in `src/config.ts` /
  `src/container-runner.ts`
- `ensureSidecar('playwright-mcp')` call in `src/index.ts` boot

## Phase 3: First boot

`start.sh` is idempotent and the nanoclaw service invokes it automatically at
startup. To run manually the first time:

```bash
bash container/playwright-mcp/start.sh
```

This will:

- Generate `PLAYWRIGHT_MCP_TOKEN` and persist to `.env` (only on first run).
- Build the sidecar image (cached after first build via src-hash label).
- Launch the container with `--restart unless-stopped` and a healthcheck.

## Phase 4: Verify

```bash
docker ps --filter name=playwright-mcp --format '{{.Status}}'
# expect: Up <time> (healthy)
```

Then ask the assistant in any registered chat: `use playwright to open example.com and take a screenshot`.

## Removal

```bash
docker rm -f playwright-mcp
docker rmi nanoclaw-playwright-mcp:latest
git revert <merge-commit> -m 1
```
