import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { TimeRange, UiError } from '@colabdeck/shared';
import { useHostMessenger } from './hooks/useHostMessenger.js';
import { EmptyState } from './components/EmptyState.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { Header } from './components/Header.js';
import { IdleGuardCard } from './components/IdleGuardCard.js';
import { NotebookDashboard } from './components/NotebookDashboard.js';
import { PerformanceCards } from './components/PerformanceCards.js';
import { Toolbox } from './components/Toolbox.js';

type MonitorSource = 'notebook' | 'mounted';

export function App(): JSX.Element {
  const { state, post } = useHostMessenger();
  const [source, setSource] = useState<MonitorSource>('notebook');
  const [rangeOverride, setRangeOverride] = useState<TimeRange | null>(null);
  const snapshot = state.snapshot;
  const idle = state.idle ?? snapshot?.idleGuard ?? null;
  const countdown = state.idle ? state.countdown : (snapshot?.countdown ?? null);
  const transitions = state.transitions;
  const errors = state.errors.length > 0 ? state.errors : (snapshot?.errors ?? []);
  const latest =
    (state.samples.length > 0 ? state.samples[state.samples.length - 1] : snapshot?.latest) ?? null;
  const settings = snapshot?.settings ?? null;
  const range = rangeOverride ?? settings?.timeRange ?? '30m';
  const selectedId = snapshot?.selectedServerId ?? null;
  const connection = snapshot?.connection ?? 'disconnected';
  const snoozeMinutes = settings?.idleGuard.snoozeMinutes ?? 30;

  if (state.mismatch) {
    return (
      <div class="app">
        <div class="card mismatch">
          <h2>Dashboard version mismatch</h2>
          <p class="muted">
            Reopen the ColabDeck view. If the message persists, save your work and reload VS Code manually.
          </p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div class="app">
        <div class="card loading">Connecting to the ColabDeck extension host…</div>
      </div>
    );
  }

  const sourceSwitch = (
    <div class="monitor-source" role="group" aria-label="Monitoring source">
      <button
        type="button"
        class={source === 'notebook' ? '' : 'secondary'}
        aria-pressed={source === 'notebook'}
        onClick={() => setSource('notebook')}
      >
        Notebook
      </button>
      <button
        type="button"
        class={source === 'mounted' ? '' : 'secondary'}
        aria-pressed={source === 'mounted'}
        onClick={() => setSource('mounted')}
      >
        Mounted runtime
      </button>
    </div>
  );

  if (source === 'notebook') {
    return (
      <div class="app">
        {sourceSwitch}
        <NotebookDashboard
          view={state.notebook}
          activeNotebookLabel={snapshot.activeNotebookLabel}
          onStart={() => post({ type: 'START_NOTEBOOK_MONITORING' })}
          onSync={() => post({ type: 'SYNC_NOTEBOOK_MONITORING' })}
          onStop={() => post({ type: 'STOP_NOTEBOOK_MONITORING' })}
        />
      </div>
    );
  }

  const requestSnapshot = (nextRange: TimeRange): void => {
    post({ type: 'REQUEST_SNAPSHOT', requestId: crypto.randomUUID(), range: nextRange });
  };
  const refreshServers = (): void => post({ type: 'REFRESH_SERVERS' });

  const handleErrorAction = (action: UiError['action']): void => {
    if (action === 'RETRY') {
      post({ type: 'RETRY_PROBE' });
    } else if (action === 'OPEN_SETTINGS') {
      post({ type: 'OPEN_SETTINGS' });
    } else if (action === 'OPEN_PROBE_LOG') {
      post({ type: 'OPEN_PROBE_LOG' });
    } else if (action === 'MOUNT_COLAB_SERVER') {
      post({ type: 'MOUNT_COLAB_SERVER' });
    }
  };

  return (
    <div class="app">
      {sourceSwitch}
      <Header
        servers={snapshot.servers}
        selectedId={selectedId}
        connection={connection}
        range={range}
        onSelect={(serverId) => post({ type: 'SELECT_SERVER', serverId })}
        onRange={(nextRange) => {
          setRangeOverride(nextRange);
          requestSnapshot(nextRange);
        }}
        onRefresh={refreshServers}
        onStart={() => post({ type: 'START_MONITORING' })}
        onOpenSettings={() => post({ type: 'OPEN_SETTINGS' })}
      />
      <ErrorBanner
        errors={errors}
        onDismiss={(errorId) => post({ type: 'DISMISS_ERROR', errorId })}
        onAction={handleErrorAction}
      />
      {!selectedId ? (
        <EmptyState
          hasServers={snapshot.servers.length > 0}
          onMountServer={() => post({ type: 'MOUNT_COLAB_SERVER' })}
          onRefresh={refreshServers}
          onOpenSettings={() => post({ type: 'OPEN_SETTINGS' })}
        />
      ) : connection === 'disconnected' ? (
        <section class="card empty-state">
          <h2>Monitoring is not running</h2>
          <p class="muted">
            Open the terminal for this runtime in the official Colab extension, then select Start Monitoring.
          </p>
        </section>
      ) : (
        <div class="dashboard">
          <section class="column dashboard-main">
            <PerformanceCards
              latest={latest}
              samples={state.samples}
              connection={connection}
              probe={snapshot.probe ?? null}
            />
          </section>
          <div class="dashboard-side">
            <IdleGuardCard
              idle={idle}
              countdown={countdown}
              transitions={transitions}
              countdownMs={(settings?.idleGuard.countdownSeconds ?? 120) * 1000}
              snoozeMinutes={snoozeMinutes}
              onToggle={(enabled) => post({ type: 'IDLE_GUARD_SET_ENABLED', enabled })}
              onCancel={() => post({ type: 'IDLE_GUARD_CANCEL', requestId: crypto.randomUUID(), source: 'webview' })}
              onSnooze={() =>
                post({
                  type: 'IDLE_GUARD_SNOOZE',
                  requestId: crypto.randomUUID(),
                  durationMs: snoozeMinutes * 60_000,
                  source: 'webview',
                })
              }
              onRelease={() =>
                post({ type: 'IDLE_GUARD_RELEASE_NOW', requestId: crypto.randomUUID(), source: 'webview' })
              }
            />
            <Toolbox
              processes={state.processes}
              processSource={state.processSource}
              processWarning={state.processWarning}
              result={state.toolboxResult?.result ?? null}
              onRefreshProcesses={() =>
                post({ type: 'REFRESH_GPU_PROCESSES', requestId: crypto.randomUUID() })
              }
              onKill={(pid) => post({ type: 'KILL_PROCESS', requestId: crypto.randomUUID(), pid })}
              onScan={(path, maxEntries, maxDepth) =>
                post({
                  type: 'SCAN_DISK',
                  requestId: crypto.randomUUID(),
                  path,
                  maxEntries,
                  maxDepth,
                })
              }
              onClearCudaCache={() =>
                post({ type: 'CLEAR_CUDA_CACHE', requestId: crypto.randomUUID() })
              }
              connected={connection === 'connected'}
              showProcesses={settings?.showProcesses ?? true}
            />
          </div>
        </div>
      )}
    </div>
  );
}
