import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { TelemetrySample, TimeRange, UiError } from '@colabdeck/shared';
import { useHostMessenger } from './hooks/useHostMessenger.js';
import { EmptyState } from './components/EmptyState.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { GpuCard } from './components/GpuCard.js';
import { Header } from './components/Header.js';
import { IdleGuardCard } from './components/IdleGuardCard.js';
import { MetricChart } from './components/MetricChart.js';
import { Toolbox } from './components/Toolbox.js';

const gpuUtilization = (sample: TelemetrySample): number | null => sample.gpuAggregate?.utilizationPct ?? null;
const vramUsedGiB = (sample: TelemetrySample): number | null =>
  sample.gpuAggregate?.memoryUsedBytes === null || sample.gpuAggregate?.memoryUsedBytes === undefined
    ? null
    : sample.gpuAggregate.memoryUsedBytes / 1024 / 1024 / 1024;
const ramUsedGiB = (sample: TelemetrySample): number | null => sample.ram.usedBytes / 1024 / 1024 / 1024;
const diskUsedGiB = (sample: TelemetrySample): number | null => sample.disk.usedBytes / 1024 / 1024 / 1024;
const percentLabel = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`);
const gibLabel = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)} GiB`);

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
  const snoozeMinutes = settings?.idleGuard.snoozeMinutes ?? 30;

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
    } else if (action === 'MOUNT_COLAB_SERVER') {
      post({ type: 'MOUNT_COLAB_SERVER' });
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
          requestSnapshot(range);
        }}
        onRestart={() => post({ type: 'RETRY_PROBE' })}
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
          <section class="column dashboard-main">
            <GpuCard
              latest={latest}
              samples={state.samples}
              connection={connection}
              probe={snapshot.probe ?? null}
            />
            <div class="charts-grid">
              <MetricChart
                title="GPU utilization"
                unit="%"
                samples={state.samples}
                accessor={gpuUtilization}
                color="#3794ff"
                themeColor="--vscode-charts-blue"
                yMax={100}
                valueFormatter={percentLabel}
              />
              <MetricChart
                title="VRAM"
                unit="GiB"
                samples={state.samples}
                accessor={vramUsedGiB}
                color="#f7b955"
                themeColor="--vscode-charts-yellow"
                yMax={
                  latest?.gpuAggregate?.memoryTotalBytes
                    ? latest.gpuAggregate.memoryTotalBytes / 1024 / 1024 / 1024
                    : 100
                }
                valueFormatter={gibLabel}
              />
              <MetricChart
                title="System RAM"
                unit="GiB"
                samples={state.samples}
                accessor={ramUsedGiB}
                color="#89d185"
                themeColor="--vscode-charts-green"
                yMax={latest ? latest.ram.totalBytes / 1024 / 1024 / 1024 : 100}
                valueFormatter={gibLabel}
              />
              <MetricChart
                title="Disk used"
                unit="GiB"
                samples={state.samples}
                accessor={diskUsedGiB}
                color="#d18616"
                themeColor="--vscode-charts-orange"
                yMax={latest ? latest.disk.totalBytes / 1024 / 1024 / 1024 : 100}
                valueFormatter={gibLabel}
              />
            </div>
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
