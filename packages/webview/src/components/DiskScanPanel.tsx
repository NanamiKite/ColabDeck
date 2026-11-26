import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { formatBytes } from '@colabdeck/shared';
import type { ToolboxResult } from '@colabdeck/shared';

interface DiskScanPanelProps {
  readonly result: ToolboxResult | null;
  readonly onScan: (path: string, maxEntries: number, maxDepth: number) => void;
}

export function DiskScanPanel({ result, onScan }: DiskScanPanelProps): JSX.Element {
  const [path, setPath] = useState('/content');
  const [maxEntries, setMaxEntries] = useState(50);
  const [maxDepth, setMaxDepth] = useState(4);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
  }, [result]);

  useEffect(() => {
    if (!busy) {
      return;
    }
    const timer = setTimeout(() => setBusy(false), 15_000);
    return () => clearTimeout(timer);
  }, [busy]);

  const scanResult = result?.kind === 'SCAN_DISK' ? result : null;
  return (
    <div class="disk-panel">
      <div class="panel-head">
        <div>
          <h3>Disk scan</h3>
          <span class="muted">read-only · /content and /tmp only</span>
        </div>
      </div>
      <div class="inline-fields">
        <label class="field grow">
          <span>Path</span>
          <input value={path} onChange={(event) => setPath(event.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Top N</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxEntries}
            onChange={(event) => setMaxEntries(Number(event.currentTarget.value))}
          />
        </label>
        <label class="field">
          <span>Depth</span>
          <input
            type="number"
            min={0}
            max={16}
            value={maxDepth}
            onChange={(event) => setMaxDepth(Number(event.currentTarget.value))}
          />
        </label>
        <button
          class="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onScan(path, maxEntries, maxDepth);
          }}
        >
          {busy ? 'Scanning…' : 'Scan'}
        </button>
      </div>
      {scanResult ? (
        <div class="scan-results">
          <div class="muted">
            {scanResult.entries.length} entries
            {scanResult.truncated ? ' (truncated)' : ''}
          </div>
          <table>
            <colgroup>
              <col />
              <col class="col-size" />
            </colgroup>
            <thead>
              <tr>
                <th>Path</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {scanResult.entries.map((entry) => (
                <tr key={entry.path}>
                  <td class="command" title={entry.path}>
                    {entry.path}
                  </td>
                  <td class="mono">{formatBytes(entry.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">No scan yet</p>
      )}
    </div>
  );
}
