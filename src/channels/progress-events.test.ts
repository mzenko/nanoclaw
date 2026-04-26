/**
 * Type-equivalence guard: the host-side and container-side ProgressEvent
 * declarations must stay byte-identical, since they describe the same JSON
 * wire format and there's no shared package to import from. The host runs
 * on Node + pnpm, the container on Bun — they can't import each other's
 * source. So instead we assert the type-defining region of both files is
 * exactly the same.
 *
 * If this test fails after editing one file, copy the change to the other.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

const HOST_FILE = path.resolve(__dirname, 'progress-events.ts');
const CONTAINER_FILE = path.resolve(__dirname, '..', '..', 'container', 'agent-runner', 'src', 'progress-events.ts');

/** Strip the leading docblock — each file has its own that explains why
 * the duplication exists. Compare the actual type declaration only. */
function typeBody(src: string): string {
  const startIdx = src.indexOf('export type ProgressEvent');
  if (startIdx < 0) throw new Error(`No ProgressEvent export found`);
  return src.slice(startIdx).trim();
}

describe('ProgressEvent type equivalence', () => {
  it('host and container declare the same ProgressEvent shape', () => {
    const host = fs.readFileSync(HOST_FILE, 'utf-8');
    const container = fs.readFileSync(CONTAINER_FILE, 'utf-8');
    expect(typeBody(host)).toBe(typeBody(container));
  });
});
