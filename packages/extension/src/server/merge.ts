import type { ServerDescriptor } from '@colabdeck/shared';

const PRIORITY: Readonly<Record<ServerDescriptor['source'], number>> = {
  'mounted-folder': 0,
  'kernel-api': 1,
  persisted: 2,
};

export function mergeServers(
  ...sources: readonly (readonly ServerDescriptor[] | undefined)[]
): ServerDescriptor[] {
  const byId = new Map<string, ServerDescriptor>();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const server of source) {
      if (!server.id) {
        continue;
      }
      const existing = byId.get(server.id);
      if (!existing || PRIORITY[server.source] < PRIORITY[existing.source]) {
        byId.set(server.id, server);
      }
    }
  }
  return [...byId.values()].sort((left, right) => {
    const priority = PRIORITY[left.source] - PRIORITY[right.source];
    return priority !== 0 ? priority : left.label.localeCompare(right.label);
  });
}
