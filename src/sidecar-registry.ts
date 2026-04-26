export const SIDECARS = [
  {
    key: 'ha',
    dir: 'ha-mcp',
    requiredEnv: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'],
    tokenEnv: 'HA_MCP_TOKEN',
    tokenFile: 'ha.token',
  },
  {
    key: 'workspace',
    dir: 'workspace-mcp',
    requiredEnv: ['USER_GOOGLE_EMAIL', 'ONECLI_URL'],
    tokenEnv: 'WORKSPACE_MCP_TOKEN',
    tokenFile: 'workspace.token',
  },
  {
    key: 'playwright',
    dir: 'playwright-mcp',
    enabledEnv: 'PLAYWRIGHT_MCP_ENABLED',
    requiredEnv: [],
    tokenEnv: 'PLAYWRIGHT_MCP_TOKEN',
    tokenFile: 'playwright.token',
  },
] as const;

export const SIDECAR_NETWORK_NAME = 'nanoclaw';

export const SIDECAR_NO_PROXY_HOSTS = SIDECARS.map((sidecar) => sidecar.dir);

export type SidecarSpec = (typeof SIDECARS)[number];

export function sidecarEnvKeys(): string[] {
  return SIDECARS.flatMap((sidecar) => [
    ...sidecar.requiredEnv,
    ...('enabledEnv' in sidecar ? [sidecar.enabledEnv] : []),
  ]);
}

export function isSidecarEnabled(sidecar: SidecarSpec, env: Record<string, string>): boolean {
  if (!('enabledEnv' in sidecar)) return true;
  return ['1', 'true', 'yes', 'on'].includes((env[sidecar.enabledEnv] ?? '').toLowerCase());
}
