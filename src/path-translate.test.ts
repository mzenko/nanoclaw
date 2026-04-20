import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/test-root/groups',
  PROJECT_ROOT: '/test-root',
  DATA_DIR: '/test-root/data',
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => {
    if (folder === 'global') {
      throw new Error('Invalid group folder "global"');
    }
    return path.join('/test-root/groups', folder);
  },
}));

import { translateContainerPath } from './path-translate.js';

describe('translateContainerPath', () => {
  it('resolves /workspace/group/<file> under the group folder', () => {
    expect(translateContainerPath('/workspace/group/foo.png', 'mygroup')).toBe(
      '/test-root/groups/mygroup/foo.png',
    );
  });

  it('resolves /workspace/global/<file> under groups/global without throwing', () => {
    // Regression for H1: resolveGroupFolderPath('global') throws because
    // 'global' is reserved; the global branch must use GROUPS_DIR directly.
    expect(translateContainerPath('/workspace/global/bar.png', 'mygroup')).toBe(
      '/test-root/groups/global/bar.png',
    );
  });

  it('blocks ..-traversal out of the group root', () => {
    expect(
      translateContainerPath('/workspace/group/../../etc/passwd', 'mygroup'),
    ).toBeNull();
  });

  it('blocks ..-traversal out of the global root', () => {
    expect(
      translateContainerPath('/workspace/global/../etc/passwd', 'mygroup'),
    ).toBeNull();
  });

  it('returns null for paths outside the allowed mounts', () => {
    expect(translateContainerPath('/etc/passwd', 'mygroup')).toBeNull();
    expect(translateContainerPath('/tmp/foo', 'mygroup')).toBeNull();
    expect(translateContainerPath('relative/path', 'mygroup')).toBeNull();
  });

  it('normalizes redundant slashes and dot segments', () => {
    expect(
      translateContainerPath('/workspace/group/./sub//file.txt', 'mygroup'),
    ).toBe('/test-root/groups/mygroup/sub/file.txt');
  });

  it('resolves the group root itself (no trailing path)', () => {
    expect(translateContainerPath('/workspace/group', 'mygroup')).toBe(
      '/test-root/groups/mygroup',
    );
  });

  it('resolves the global root itself (no trailing path)', () => {
    expect(translateContainerPath('/workspace/global', 'mygroup')).toBe(
      '/test-root/groups/global',
    );
  });

  it('handles a sub-path under global', () => {
    expect(
      translateContainerPath('/workspace/global/CLAUDE.md', 'mygroup'),
    ).toBe('/test-root/groups/global/CLAUDE.md');
  });
});
