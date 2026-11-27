import type { JSX } from 'preact';

interface EmptyStateProps {
  readonly hasServers: boolean;
  readonly onMountServer: () => void;
  readonly onRefresh: () => void;
  readonly onOpenSettings: () => void;
}

export function EmptyState({
  hasServers,
  onMountServer,
  onRefresh,
  onOpenSettings,
}: EmptyStateProps): JSX.Element {
  return (
    <section class="card empty-state">
      <div class="eyebrow">{hasServers ? 'No server selected' : 'No runtime selected'}</div>
      <h2>{hasServers ? 'Pick a server to monitor' : 'Mount a Colab server'}</h2>
      <p class="muted">
        {hasServers
          ? 'Choose a mounted runtime in the Server dropdown, then select Start Monitoring.'
          : 'Assign a runtime in the official Colab extension, then mount it in this workspace.'}
      </p>
      <div class="button-row">
        <button onClick={onMountServer}>Mount server</button>
        <button class="secondary" onClick={onRefresh}>
          Refresh
        </button>
        <button class="secondary" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </section>
  );
}
