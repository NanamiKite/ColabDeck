import type { JSX } from 'preact';

interface EmptyStateProps {
  readonly onMountServer: () => void;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
}

export function EmptyState({ onMountServer, onRetry, onOpenSettings }: EmptyStateProps): JSX.Element {
  return (
    <section class="card empty-state">
      <div class="eyebrow">No runtime selected</div>
      <h2>Mount a Colab server</h2>
      <p class="muted">Choose an assigned runtime in the official Colab extension to start monitoring.</p>
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
