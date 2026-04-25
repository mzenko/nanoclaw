# 01 — Marker nonce + agent-runner stdout protections

## Intent

Prevents stdout from a previous container turn (still draining) from being mis-parsed as the current turn's output/progress. Also enforces a hard fail-fast in the agent-runner if the host forgot to set the nonce — silent drift between host and runner is the #1 cause of mysterious progress-embed corruption.

## Implementation

**Host side** (`src/container-runner.ts` in v1):
- Generate a fresh UUID per container spawn: `const markerNonce = crypto.randomUUID()`
- Pass via `-e NANOCLAW_MARKER_NONCE=${markerNonce}` to the agent container
- When parsing the container's stdout, build the markers using the same nonce: `---NANOCLAW_OUTPUT_START_${markerNonce}---` / `---NANOCLAW_OUTPUT_END_${markerNonce}---` and `---NANOCLAW_PROGRESS_START_${markerNonce}---` / `---NANOCLAW_PROGRESS_END_${markerNonce}---`

**Runner side** (`container/agent-runner/src/index.ts` in v1, lines ~118-134):
- Read `NANOCLAW_MARKER_NONCE` from env
- Throw immediately if absent (don't continue silently)
- Use the nonce when emitting any output/progress markers to stdout

## V2 reapplication

Find v2's equivalent of `container-runner.ts` (likely still `src/container-runner.ts` per HEAD inspection) and the agent-runner's I/O surface. v2 may have replaced stdout-marker IPC with the two-DB model entirely (`inbound.db`/`outbound.db`); if so, **this customization is OBSOLETE and should be dropped**. Verify by inspecting how v2's host reads container output.

If v2 still uses stdout markers anywhere, port the nonce pattern.

## Files involved (v1)
- `src/container-runner.ts` — lines around 287, 518 (per Phase B sub-agent report)
- `container/agent-runner/src/index.ts` — lines 118-134
