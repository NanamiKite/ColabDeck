import type { JSX } from 'preact';
import type { ProbeConnectionState, ServerView, TimeRange } from '@colabdeck/shared';
import { RefreshIcon, SettingsIcon } from './Icons.js';

interface HeaderProps {
  readonly servers: readonly ServerView[];
  readonly selectedId: string | null;
  readonly connection: ProbeConnectionState;
  readonly range: TimeRange;
  readonly onSelect: (serverId: string) => void;
  readonly onRange: (range: TimeRange) => void;
  readonly onRefresh: () => void;
  readonly onStart: () => void;
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
  onStart,
  onOpenSettings,
}: HeaderProps): JSX.Element {
  const connectionLabel: Readonly<Record<ProbeConnectionState, string>> = {
    connected: 'Connected',
    syncing: 'Starting',
    stale: 'Out of date',
    disconnected: 'Disconnected',
    error: 'Error',
  };
  const retryable = connection === 'error' || connection === 'stale';
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
            {servers.length > 0 && selectedId === null ? (
              <option value="" disabled>
                Select a server…
              </option>
            ) : null}
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
        <span class={`badge ${connection}`}>{connectionLabel[connection]}</span>
        {selectedId !== null && (connection === 'disconnected' || retryable) ? (
          <button class="small" onClick={onStart}>
            {retryable ? 'Retry Monitoring' : 'Start Monitoring'}
          </button>
        ) : null}
        <button
          class="icon-button"
          title="Refresh the server list and dashboard"
          aria-label="Refresh the server list and dashboard"
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
        <button
          class="icon-button"
          title="Open ColabDeck settings"
          aria-label="Open ColabDeck settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
