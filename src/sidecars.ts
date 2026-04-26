/**
 * Long-running HTTP MCP sidecars.
 *
 * Each sidecar is a docker container on the shared `nanoclaw` network that
 * exposes an HTTP MCP behind a per-sidecar bearer token. The agent container
 * connects to them by hostname (`http://ha-mcp:8000/mcp` etc).
 *
 * Lifecycle: each sidecar has its own `start.sh` that's idempotent — generates
 * its bearer token if missing, builds its image if source changed, runs `docker
 * run -d --restart unless-stopped`. We just shell out to those scripts at host
 * boot and let docker keep them alive.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { log } from './log.js';
import { isSidecarEnabled, SIDECAR_NETWORK_NAME, SIDECARS, sidecarEnvKeys } from './sidecar-registry.js';

function ensureNetwork(): boolean {
  // Inspect first; only create if missing. Both calls are cheap (~5ms).
  const inspect = spawnSync('docker', ['network', 'inspect', SIDECAR_NETWORK_NAME], { stdio: 'pipe' });
  if (inspect.status === 0) return true;
  const create = spawnSync('docker', ['network', 'create', SIDECAR_NETWORK_NAME], { stdio: 'pipe' });
  if (create.status === 0) {
    log.info('Created docker network', { network: SIDECAR_NETWORK_NAME });
    return true;
  }
  log.warn('Failed to create docker network; sidecars unavailable', {
    network: SIDECAR_NETWORK_NAME,
    stderr: create.stderr?.toString().trim().slice(-200),
  });
  return false;
}

/** Run all enabled sidecar start scripts. Non-fatal: logs and continues. */
export function ensureSidecars(projectRoot: string): void {
  if (!ensureNetwork()) return;
  const env = readEnvFile(sidecarEnvKeys());
  for (const spec of SIDECARS) {
    const startScript = path.join(projectRoot, 'container', spec.dir, 'start.sh');
    if (!fs.existsSync(startScript)) {
      log.debug('Sidecar start.sh missing; skipping', { sidecar: spec.dir });
      continue;
    }
    if (!isSidecarEnabled(spec, env)) {
      log.info('Sidecar skipped (not enabled)', { sidecar: spec.dir });
      continue;
    }
    if (spec.requiredEnv.length > 0) {
      const missing = spec.requiredEnv.filter((k) => !env[k]);
      if (missing.length > 0) {
        log.info('Sidecar skipped (missing env)', { sidecar: spec.dir, missing });
        continue;
      }
    }
    const result = spawnSync('bash', [startScript], { cwd: projectRoot, stdio: 'pipe' });
    if (result.status === 0) {
      log.info('Sidecar ready', { sidecar: spec.dir });
    } else {
      // Don't fail boot — the agent will just lose those MCPs until next restart.
      log.warn('Sidecar start failed', {
        sidecar: spec.dir,
        status: result.status,
        stderr: result.stderr?.toString().trim().slice(-500),
      });
    }
  }
}
