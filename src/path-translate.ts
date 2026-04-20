import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';

/**
 * Translate an in-container path the agent supplied (e.g. /workspace/group/x.png)
 * to the corresponding host path. Returns null for paths that escape the
 * allowed mounted dirs — the agent only has writable access to /workspace/group
 * and read access to /workspace/global; anything else is either an error or a
 * traversal attempt.
 *
 * Uses GROUPS_DIR directly for the global folder because resolveGroupFolderPath
 * rejects 'global' as a reserved name (it isn't a registerable group). Group
 * folders go through resolveGroupFolderPath as a sanity check.
 */
export function translateContainerPath(
  containerPath: string,
  sourceGroup: string,
): string | null {
  const normalized = path.posix.normalize(containerPath);
  const groupPrefix = '/workspace/group/';
  const globalPrefix = '/workspace/global/';
  let hostBase: string;
  let rel: string;
  if (normalized === '/workspace/group' || normalized.startsWith(groupPrefix)) {
    hostBase = resolveGroupFolderPath(sourceGroup);
    rel = normalized.slice(groupPrefix.length);
  } else if (
    normalized === '/workspace/global' ||
    normalized.startsWith(globalPrefix)
  ) {
    hostBase = path.join(GROUPS_DIR, 'global');
    rel = normalized.slice(globalPrefix.length);
  } else {
    return null;
  }
  // Final containment check after resolving symlinks/.. — prevents an agent
  // from passing /workspace/group/../../etc/passwd.
  const hostPath = path.resolve(hostBase, rel);
  const hostBaseResolved = path.resolve(hostBase);
  if (
    hostPath !== hostBaseResolved &&
    !hostPath.startsWith(hostBaseResolved + path.sep)
  ) {
    return null;
  }
  return hostPath;
}
