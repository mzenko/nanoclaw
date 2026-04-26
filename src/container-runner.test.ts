import { describe, expect, it } from 'vitest';

import { buildSidecarContainerArgs, mergeDockerEnv, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('buildSidecarContainerArgs', () => {
  it('injects enabled sidecar tokens and bypasses the proxy for sidecar hostnames', () => {
    const args = buildSidecarContainerArgs({ PLAYWRIGHT_MCP_ENABLED: '1' }, (tokenFile) =>
      tokenFile === 'playwright.token' ? 'pw-token' : '',
    );

    expect(args.envArgs).toContain('PLAYWRIGHT_MCP_TOKEN=pw-token');
    expect(args.networkName).toBe('nanoclaw');
    expect(args.noProxyHosts).toContain('ha-mcp');
    expect(args.noProxyHosts).toContain('workspace-mcp');
    expect(args.noProxyHosts).toContain('playwright-mcp');
  });

  it('does not inject Playwright token when Playwright sidecar is disabled', () => {
    const args = buildSidecarContainerArgs({}, (tokenFile) => (tokenFile === 'playwright.token' ? 'pw-token' : ''));

    expect(args.envArgs).not.toContain('PLAYWRIGHT_MCP_TOKEN=pw-token');
    expect(args.networkName).toBeUndefined();
    expect(args.noProxyHosts).toEqual([]);
  });
});

describe('mergeDockerEnv', () => {
  it('merges with existing docker env values instead of replacing them', () => {
    const args = ['run', '-e', 'NO_PROXY=onecli.internal,localhost', '-e', 'OTHER=value'];

    mergeDockerEnv(args, 'NO_PROXY', ['ha-mcp', 'playwright-mcp', 'localhost']);

    expect(args).toEqual([
      'run',
      '-e',
      'OTHER=value',
      '-e',
      'NO_PROXY=onecli.internal,localhost,ha-mcp,playwright-mcp',
    ]);
  });
});
