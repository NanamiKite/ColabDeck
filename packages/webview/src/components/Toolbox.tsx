import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { GpuProcessView, ToolboxResult } from '@colabdeck/shared';
import { CudaCacheCard } from './CudaCacheCard.js';
import { DiskScanPanel } from './DiskScanPanel.js';
import { ProcessTable } from './ProcessTable.js';

interface ToolboxProps {
  readonly processes: readonly GpuProcessView[];
  readonly processSource: 'nvidia-smi' | 'procfs' | 'none';
  readonly processWarning: string | null;
  readonly result: ToolboxResult | null;
  readonly onRefreshProcesses: () => void;
  readonly onKill: (pid: number) => void;
  readonly onScan: (path: string, maxEntries: number, maxDepth: number) => void;
  readonly onClearCudaCache: () => void;
  readonly connected: boolean;
}

export function Toolbox({
  processes,
  processSource,
  processWarning,
  result,
  onRefreshProcesses,
  onKill,
  onScan,
  onClearCudaCache,
  connected,
}: ToolboxProps): JSX.Element {
  const [tab, setTab] = useState<'processes' | 'disk' | 'cuda'>('processes');

  useEffect(() => {
    if (connected) {
      onRefreshProcesses();
    }
    // Refresh once when the toolbox mounts; manual refresh is still available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
  return (
    <section class="card toolbox-card">
      <div class="card-head">
        <div>
          <div class="eyebrow">Diagnostics</div>
          <h2>Toolbox</h2>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button
          class={tab === 'processes' ? 'tab active' : 'tab'}
          onClick={() => {
            setTab('processes');
            onRefreshProcesses();
          }}
        >
          Processes
        </button>
        <button class={tab === 'disk' ? 'tab active' : 'tab'} onClick={() => setTab('disk')}>
          Disk
        </button>
        <button class={tab === 'cuda' ? 'tab active' : 'tab'} onClick={() => setTab('cuda')}>
          CUDA cache
        </button>
      </div>
      {tab === 'processes' ? (
        <ProcessTable
          processes={processes}
          source={processSource}
          warning={processWarning}
          onRefresh={onRefreshProcesses}
          onKill={onKill}
        />
      ) : null}
      {tab === 'disk' ? <DiskScanPanel result={result} onScan={onScan} /> : null}
      {tab === 'cuda' ? <CudaCacheCard result={result} onClear={onClearCudaCache} /> : null}
    </section>
  );
}
