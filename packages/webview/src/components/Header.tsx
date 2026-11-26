import type { JSX } from 'preact';
import type { ServerView, TimeRange } from '@colabdeck/shared';

interface HeaderProps {
  readonly servers: readonly ServerView[];
  readonly selectedId: string | null;
  readonly connection: string;
  readonly range: TimeRange;
  readonly onSelect: (serverId: string) => void;
  readonly onRange: (range: TimeRange) => void;
  readonly onRefresh: () => void;
  readonly onOpenSettings: () => void;
}

export function Header({
  servers,
  selectedId,
  connection,
  range,
  onSelect,
  onRange,
  onRefresh,
  onOpenSettings,
}: HeaderProps): JSX.Element {
  const connectionLabel: Readonly<Record<string, string>> = {
    connected: 'Connected',
    syncing: 'Starting',
    stale: 'Out of date',
    disconnected: 'Disconnected',
    error: 'Error',
  };
  const connectionClass = connection;
  return (
    <header class="header">
      <div class="brand">
        <span class="brand-mark">CD</span>
        <div>
          <div class="brand-title">ColabDeck</div>
          <div class="brand-subtitle">runtime companion</div>
        </div>
      </div>
      <div class="header-controls">
        <label class="field">
          <span>Server</span>
          <select
            value={selectedId ?? ''}
            disabled={servers.length === 0}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value) {
                onSelect(value);
              }
            }}
          >
            {servers.length === 0 ? <option value="">No Colab server</option> : null}
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.label}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>Range</span>
          <select value={range} onChange={(event) => onRange(event.currentTarget.value as TimeRange)}>
            <option value="15m">15m</option>
            <option value="30m">30m</option>
            <option value="1h">1h</option>
          </select>
        </label>
        <span class={`badge ${connectionClass}`}>{connectionLabel[connection] ?? 'Unknown'}</span>
        <button
          class="icon-button"
          title="Refresh monitoring"
          aria-label="Refresh monitoring"
          onClick={onRefresh}
        >
          ↻
        </button>
        <button
          class="icon-button"
          title="Open ColabDeck settings"
          aria-label="Open ColabDeck settings"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
