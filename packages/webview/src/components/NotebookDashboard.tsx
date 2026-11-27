import type { JSX } from 'preact';
import type { NotebookMonitorView } from '@colabdeck/shared';
import { PerformanceCards } from './PerformanceCards.js';

interface NotebookDashboardProps {
  readonly view: NotebookMonitorView | null;
  readonly activeNotebookLabel: string | null;
  readonly onStart: () => void;
  readonly onSync: () => void;
  readonly onStop: () => void;
}

const statusLabels: Readonly<Record<NotebookMonitorView['state'], string>> = {
  idle: 'Not recording',
  starting: 'Starting',
  recording: 'Recording',
  syncing: 'Syncing',
  stopping: 'Stopping',
};

export function NotebookDashboard({
  view,
  activeNotebookLabel,
  onStart,
  onSync,
  onStop,
}: NotebookDashboardProps): JSX.Element {
  const state = view?.state ?? 'idle';
  const sessionLabel = view?.notebookLabel ?? null;
  const notebookLabel = sessionLabel ?? activeNotebookLabel;
  const showActiveNotebook = sessionLabel !== null && sessionLabel !== activeNotebookLabel;
  const canStart = state === 'idle' && activeNotebookLabel !== null && (view === null || view.canStart === true);
  const canSync = state === 'recording' && view?.canSync === true;
  const canStop = state === 'recording' && view?.canStop === true;
  const badgeClass = state === 'recording' ? ' connected' : state === 'idle' ? '' : ' syncing';
  const samples = view?.samples ?? [];
  const latest = samples[samples.length - 1] ?? null;

  return (
    <div class="column notebook-dashboard">
      <section class="card notebook-monitor">
        <div class="card-head">
          <div class="notebook-identity">
            <div class="eyebrow">Notebook monitoring</div>
            <h2>{notebookLabel ?? 'No active notebook'}</h2>
          </div>
          <span class={`badge${badgeClass}`} role="status">{statusLabels[state]}</span>
        </div>
        {showActiveNotebook ? (
          <p class="muted">Active notebook: {activeNotebookLabel ?? 'None'}</p>
        ) : null}
        <p class="muted">
          Run a cell on your connected Colab kernel before starting. No runtime mount or terminal is needed.
        </p>
        <p class="muted">
          Samples are recorded in the background during training. Select Sync samples when the kernel is idle to update
          the charts; they do not refresh automatically.
        </p>
        {view?.message ? <p class="reason" role="status">{view.message}</p> : null}
        <div class="button-row">
          <button type="button" disabled={!canStart} onClick={onStart}>Start monitoring</button>
          <button type="button" class="secondary" disabled={!canSync} onClick={onSync}>Sync samples</button>
          <button type="button" class="secondary" disabled={!canStop} onClick={onStop}>Stop</button>
        </div>
      </section>
      {latest ? (
        <PerformanceCards latest={latest} samples={samples} connection="connected" sampleTimeMode="sampled" />
      ) : null}
    </div>
  );
}
