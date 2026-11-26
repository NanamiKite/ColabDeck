import type { JSX } from 'preact';

interface EmptyStateProps {
  readonly hasServers: boolean;
  readonly onMountServer: () => void;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
}

export function EmptyState({
  hasServers,
  onMountServer,
  onRetry,
  onOpenSettings,
}: EmptyStateProps): JSX.Element {
  return (
    <section class="card empty-state">
      <div class="eyebrow">{hasServers ? 'No server selected' : 'No runtime selected'}</div>
      <h2>{hasServers ? 'Pick a server to monitor' : 'Mount a Colab server'}</h2>
      <p class="muted">
        {hasServers
          ? 'Use the Server dropdown above to choose an assigned runtime; monitoring starts automatically.'
          : 'Choose an assigned runtime in the official Colab extension to start monitoring.'}
      </p>
      <div class="button-row">
        <button onClick={onMountServer}>Mount server</button>
        <button class="secondary" onClick={onRetry}>
          Refresh
        </button>
        <button class="secondary" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </section>
  );
}
