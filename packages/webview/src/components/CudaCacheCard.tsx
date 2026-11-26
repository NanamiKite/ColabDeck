import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ToolboxResult } from '@colabdeck/shared';

interface CudaCacheCardProps {
  readonly result: ToolboxResult | null;
  readonly onClear: () => void;
  readonly disabled?: boolean;
}

export function CudaCacheCard({ result, onClear, disabled = false }: CudaCacheCardProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const clearResult = result?.kind === 'CLEAR_CUDA_CACHE' ? result : null;

  useEffect(() => {
    setBusy(false);
  }, [result]);

  useEffect(() => {
    if (!busy) {
      return;
    }
    const timer = setTimeout(() => setBusy(false), 130_000);
    return () => clearTimeout(timer);
  }, [busy]);

  return (
    <div class="cuda-card">
      <div class="panel-head">
        <div>
          <h3>CUDA cache</h3>
          <span class="muted">Release unused PyTorch cache blocks</span>
        </div>
        <button
          class="secondary"
          disabled={busy || disabled}
          onClick={() => {
            setBusy(true);
            onClear();
          }}
        >
          {busy ? 'Waiting…' : 'Clear cache'}
        </button>
      </div>
      <p class="muted">Active tensors stay allocated. If the notebook is busy, this waits for the current cell.</p>
      {clearResult ? <p class={clearResult.ok ? 'success-text' : 'warning-text'}>{clearResult.message}</p> : null}
    </div>
  );
}
