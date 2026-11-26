import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { TimeRange, UiError } from '@colabdeck/shared';
import { useHostMessenger } from './hooks/useHostMessenger.js';
import { EmptyState } from './components/EmptyState.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { GpuCard } from './components/GpuCard.js';
import { Header } from './components/Header.js';
import { IdleGuardCard } from './components/IdleGuardCard.js';
import { MetricChart } from './components/MetricChart.js';
import { Toolbox } from './components/Toolbox.js';

export function App(): JSX.Element {
  const { state, post } = useHostMessenger();
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

  if (state.mismatch) {
    return (
      <div class="app">
        <div class="card mismatch">
          <h2>Dashboard needs a reload</h2>
          <p class="muted">Reload the window to load matching ColabDeck versions.</p>
          <button onClick={() => post({ type: 'RELOAD_WINDOW' })}>Reload window</button>
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

  const requestSnapshot = (nextRange: TimeRange): void => {
    post({ type: 'REQUEST_SNAPSHOT', requestId: crypto.randomUUID(), range: nextRange });
  };

  const handleErrorAction = (action: UiError['action']): void => {
    if (action === 'RETRY') {
      post({ type: 'RETRY_PROBE' });
    } else if (action === 'OPEN_SETTINGS') {
      post({ type: 'OPEN_SETTINGS' });
    } else if (action === 'OPEN_PROBE_LOG') {
      post({ type: 'OPEN_PROBE_LOG' });
    }
  };

  return (
    <div class="app">
      <Header
        servers={snapshot.servers}
        selectedId={selectedId}
        connection={connection}
        range={range}
        onSelect={(serverId) => {
          post({ type: 'SELECT_SERVER', serverId });
          requestSnapshot(range);
        }}
        onRange={(nextRange) => {
          setRangeOverride(nextRange);
          requestSnapshot(nextRange);
        }}
        onRefresh={() => {
          post({ type: 'RETRY_PROBE' });
          requestSnapshot(range);
        }}
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
          onRetry={() => {
            post({ type: 'RETRY_PROBE' });
            requestSnapshot(range);
          }}
          onOpenSettings={() => post({ type: 'OPEN_SETTINGS' })}
        />
      ) : (
        <div class="dashboard">
          <section class="column">
            <GpuCard latest={latest} samples={state.samples} connection={connection} />
            <div class="charts-grid">
              <MetricChart
                title="GPU utilization"
                unit="%"
                samples={state.samples}
                accessor={(sample) => sample.gpuAggregate?.utilizationPct ?? null}
                color="#3794ff"
                yMax={100}
                valueFormatter={(value) => (value === null ? '—' : `${value.toFixed(1)}%`)}
              />
              <MetricChart
                title="VRAM"
                unit="GiB"
                samples={state.samples}
                accessor={(sample) =>
                  sample.gpuAggregate?.memoryUsedBytes === null || sample.gpuAggregate?.memoryUsedBytes === undefined
                    ? null
                    : sample.gpuAggregate.memoryUsedBytes / 1024 / 1024 / 1024
                }
                color="#f7b955"
                yMax={
                  latest?.gpuAggregate?.memoryTotalBytes
                    ? latest.gpuAggregate.memoryTotalBytes / 1024 / 1024 / 1024
                    : 100
                }
                valueFormatter={(value) => (value === null ? '—' : `${value.toFixed(1)} GiB`)}
              />
              <MetricChart
                title="System RAM"
                unit="GiB"
                samples={state.samples}
                accessor={(sample) => sample.ram.usedBytes / 1024 / 1024 / 1024}
                color="#89d185"
                yMax={latest ? latest.ram.totalBytes / 1024 / 1024 / 1024 : 100}
                valueFormatter={(value) => (value === null ? '—' : `${value.toFixed(1)} GiB`)}
              />
              <MetricChart
                title="Disk free"
                unit="GiB"
                samples={state.samples}
                accessor={(sample) => sample.disk.freeBytes / 1024 / 1024 / 1024}
                color="#c8c8c8"
                yMax={latest ? latest.disk.totalBytes / 1024 / 1024 / 1024 : 100}
                valueFormatter={(value) => (value === null ? '—' : `${value.toFixed(1)} GiB`)}
              />
              <MetricChart
                title="Temperature"
                unit="°C"
                samples={state.samples}
                accessor={(sample) => sample.temperature.gpuC ?? sample.temperature.cpuC}
                color="#f48771"
                yMax={120}
                valueFormatter={(value) => (value === null ? '—' : `${value.toFixed(0)} °C`)}
              />
            </div>
          </section>
          <aside class="column">
            <IdleGuardCard
              idle={idle}
              countdown={countdown}
              transitions={transitions}
              countdownMs={(settings?.idleGuard.countdownSeconds ?? 120) * 1000}
              onToggle={(enabled) => post({ type: 'IDLE_GUARD_SET_ENABLED', enabled })}
              onCancel={() => post({ type: 'IDLE_GUARD_CANCEL', requestId: crypto.randomUUID(), source: 'webview' })}
              onSnooze={() =>
                post({
                  type: 'IDLE_GUARD_SNOOZE',
                  requestId: crypto.randomUUID(),
                  durationMs: 30 * 60_000,
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
            />
          </aside>
        </div>
      )}
    </div>
  );
}
