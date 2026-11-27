import type { JSX } from 'preact';
import { formatBytes } from '@colabdeck/shared';
import type { GpuProcessView, ToolboxResult } from '@colabdeck/shared';

interface ProcessTableProps {
  readonly processes: readonly GpuProcessView[];
  readonly source: 'nvidia-smi' | 'procfs' | 'none';
  readonly warning: string | null;
  readonly connected: boolean;
  readonly result: ToolboxResult | null;
  readonly onRefresh: () => void;
  readonly onKill: (pid: number) => void;
}

export function ProcessTable({
  processes,
  source,
  warning,
  connected,
  result,
  onRefresh,
  onKill,
}: ProcessTableProps): JSX.Element {
  const killResult = result?.kind === 'KILL_PROCESS' ? result : null;
  const refreshResult = result?.kind === 'REFRESH_PROCESSES' ? result : null;
  return (
    <div class="process-table">
      <div class="panel-head">
        <div>
          <h3>GPU processes</h3>
          {connected && source === 'procfs' ? <span class="badge syncing">VRAM details unavailable</span> : null}
        </div>
        <button class="secondary small" disabled={!connected} onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {connected && warning ? <p class="warning-text">{warning}</p> : null}
      {connected && killResult ? (
        <p class={killResult.ok ? 'success-text' : 'warning-text'}>
          {killResult.message ??
            (killResult.alreadyDead
              ? `Process ${killResult.pid} already exited.`
              : `Process ${killResult.pid} stopped.`)}
        </p>
      ) : null}
      {connected && refreshResult && !refreshResult.ok ? (
        <p class="warning-text">{refreshResult.message ?? 'Could not refresh GPU processes.'}</p>
      ) : null}
      {!connected ? (
        <p class="muted">GPU processes are available when monitoring connects.</p>
      ) : processes.length === 0 ? (
        <p class="muted">No GPU processes</p>
      ) : (
        <table>
          <colgroup>
            <col class="col-pid" />
            <col class="col-name" />
            <col />
            <col class="col-vram" />
            <col class="col-kill" />
          </colgroup>
          <thead>
            <tr>
              <th>PID</th>
              <th class="col-name">Name</th>
              <th>Command</th>
              <th>VRAM</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {processes.map((process) => (
              <tr key={process.pid}>
                <td class="mono">{process.pid}</td>
                <td class="col-name">{process.name}</td>
                <td class="command" title={process.command ?? undefined}>
                  {process.command ?? '—'}
                </td>
                <td class="mono">{formatBytes(process.usedMemoryBytes)}</td>
                <td>
                  <button
                    class="danger small"
                    aria-label={`Kill GPU process ${process.pid}`}
                    onClick={() => onKill(process.pid)}
                  >
                    Kill
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
