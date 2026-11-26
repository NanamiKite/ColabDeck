import { describe, expect, it } from 'vitest';
import type { ServerDescriptor } from '@colabdeck/shared';
import { mergeServers } from './merge.js';

function server(id: string, source: ServerDescriptor['source'], label = id): ServerDescriptor {
  return {
    id,
    label,
    source,
    notebookUri: null,
    jupyterBaseUrl: null,
    kernelApiAvailable: source === 'kernel-api',
  };
}

describe('mergeServers', () => {
  it('deduplicates by id with mounted-folder priority', () => {
    const merged = mergeServers(
      [server('abc', 'mounted-folder', 'Mounted')],
      [server('abc', 'kernel-api', 'Kernel'), server('def', 'kernel-api', 'Kernel 2')],
      [server('abc', 'persisted', 'Persisted')],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.source).toBe('mounted-folder');
    expect(merged[1]?.source).toBe('kernel-api');
  });

  it('sorts mounted folders before kernel and persisted', () => {
    const merged = mergeServers([server('z', 'persisted')], [server('a', 'kernel-api'), server('b', 'mounted-folder')]);
    expect(merged.map((item) => item.id)).toEqual(['b', 'a', 'z']);
  });
});
