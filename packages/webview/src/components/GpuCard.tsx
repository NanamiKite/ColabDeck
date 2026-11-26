import type { JSX } from 'preact';
import { computeWindowPeakMemory, formatBytes, formatPercent } from '@colabdeck/shared';
import type { TelemetrySample } from '@colabdeck/shared';
import { SampleAge } from './SampleAge.js';

interface GpuCardProps {
  readonly latest: TelemetrySample | null;
  readonly samples: readonly TelemetrySample[];
  readonly connection: string;
}

function Bar({ value, max, label }: { readonly value: number | null; readonly max: number | null; readonly label: string }): JSX.Element {
  const percent = value !== null && max !== null && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div class="bar-row">
      <div class="bar-label">
        <span>{label}</span>
        <span>{formatPercent(percent, 0)}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function GpuCard({ latest, samples, connection }: GpuCardProps): JSX.Element {
  const aggregate = latest?.gpuAggregate ?? null;
  const peak = computeWindowPeakMemory(samples);
  const connected = connection === 'connected';
  const isStale = connection === 'disconnected' || connection === 'stale' || connection === 'error';
  const title = !latest ? 'Waiting for telemetry' : aggregate ? aggregate.shortName : 'No GPU detected';
  const emptyMessage = isStale
    ? 'No telemetry. Reconnect or restart the probe to resume monitoring.'
    : 'Waiting for the first telemetry sample…';
  return (
    <section class={`card gpu-card${isStale ? ' is-stale' : ''}`}>
      <div class="card-head">
        <div>
          <div class="eyebrow">Accelerator</div>
          <h2>{title}</h2>
        </div>
        <SampleAge receivedAtMs={latest?.receivedAtMs ?? null} connected={connected} />
      </div>
      {aggregate ? (
        <>
          <div class="metric-grid">
            <div class="metric">
              <span class="metric-label">GPU util</span>
              <span class="metric-value">{formatPercent(aggregate.utilizationPct)}</span>
            </div>
            <div class="metric">
              <span class="metric-label">VRAM</span>
              <span class="metric-value">
                {formatBytes(aggregate.memoryUsedBytes)} / {formatBytes(aggregate.memoryTotalBytes)}
              </span>
            </div>
            <div class="metric">
              <span class="metric-label">Window peak</span>
              <span class="metric-value">{formatBytes(peak)}</span>
            </div>
            <div class="metric">
              <span class="metric-label">GPU temp</span>
              <span class={`metric-value${aggregate.temperatureC !== null && aggregate.temperatureC >= 85 ? ' hot' : ''}`}>
                {aggregate.temperatureC === null ? '—' : `${aggregate.temperatureC.toFixed(0)} °C`}
              </span>
            </div>
            <div class="metric">
              <span class="metric-label">Power</span>
              <span class="metric-value">{aggregate.powerWatts === null ? '—' : `${aggregate.powerWatts.toFixed(0)} W`}</span>
            </div>
            <div class="metric">
              <span class="metric-label">CPU load</span>
              <span class="metric-value">{latest ? `${latest.cpu.load1.toFixed(2)} / ${latest.cpu.count}` : '—'}</span>
            </div>
          </div>
          <Bar value={aggregate.utilizationPct} max={100} label="GPU utilization" />
          <Bar value={aggregate.memoryUsedBytes} max={aggregate.memoryTotalBytes} label="VRAM" />
          <Bar value={latest?.ram.usedBytes ?? null} max={latest?.ram.totalBytes ?? null} label="System RAM" />
          <Bar value={latest?.disk.usedBytes ?? null} max={latest?.disk.totalBytes ?? null} label="Disk used" />
        </>
      ) : (
        <p class="muted">{emptyMessage}</p>
      )}
    </section>
  );
}
