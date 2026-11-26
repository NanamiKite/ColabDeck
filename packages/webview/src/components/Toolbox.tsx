import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { GpuProcessView, ToolboxResult } from '@colabdeck/shared';
import { CudaCacheCard } from './CudaCacheCard.js';
import { DiskScanPanel } from './DiskScanPanel.js';
import { ProcessTable } from './ProcessTable.js';

const TABS = ['processes', 'disk', 'cuda'] as const;
type Tab = (typeof TABS)[number];

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
  readonly showProcesses: boolean;
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
  showProcesses,
}: ToolboxProps): JSX.Element {
  const [tab, setTab] = useState<Tab>(showProcesses ? 'processes' : 'disk');
  const refreshProcesses = (): void => {
    if (connected) {
      onRefreshProcesses();
    }
  };
  const selectTab = (next: Tab): void => {
    setTab(next);
    if (next === 'processes') {
      refreshProcesses();
    }
  };
  const onTablistKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    const current = TABS.indexOf(tab);
    let next = current;
    if (event.key === 'ArrowRight') {
      next = (current + 1) % TABS.length;
    } else if (event.key === 'ArrowLeft') {
      next = (current - 1 + TABS.length) % TABS.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTab = TABS[next] ?? 'processes';
    selectTab(nextTab);
    document.getElementById(`tab-${nextTab}`)?.focus();
  };

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
      <div class="tabs" role="tablist" onKeyDown={onTablistKeyDown}>
        <button
          class={tab === 'processes' ? 'tab active' : 'tab'}
          role="tab"
          id="tab-processes"
          aria-selected={tab === 'processes'}
          aria-controls="toolbox-panel"
          tabIndex={tab === 'processes' ? 0 : -1}
          onClick={() => selectTab('processes')}
        >
          Processes
        </button>
        <button
          class={tab === 'disk' ? 'tab active' : 'tab'}
          role="tab"
          id="tab-disk"
          aria-selected={tab === 'disk'}
          aria-controls="toolbox-panel"
          tabIndex={tab === 'disk' ? 0 : -1}
          onClick={() => selectTab('disk')}
        >
          Disk
        </button>
        <button
          class={tab === 'cuda' ? 'tab active' : 'tab'}
          role="tab"
          id="tab-cuda"
          aria-selected={tab === 'cuda'}
          aria-controls="toolbox-panel"
          tabIndex={tab === 'cuda' ? 0 : -1}
          onClick={() => selectTab('cuda')}
        >
          CUDA cache
        </button>
      </div>
      <div role="tabpanel" id="toolbox-panel" aria-labelledby={`tab-${tab}`}>
      {tab === 'processes' ? (
        <ProcessTable
          processes={processes}
          source={processSource}
          warning={processWarning}
          connected={connected}
          result={result}
          onRefresh={onRefreshProcesses}
          onKill={onKill}
        />
      ) : null}
      {tab === 'disk' ? (
        <DiskScanPanel result={result} onScan={onScan} disabled={!connected} />
      ) : null}
      {tab === 'cuda' ? (
        <CudaCacheCard result={result} onClear={onClearCudaCache} disabled={!connected} />
      ) : null}
      </div>
    </section>
  );
}
