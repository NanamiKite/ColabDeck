import type { JSX } from 'preact';
import type { ProbeConnectionState, ProbeView, TelemetrySample } from '@colabdeck/shared';
import { GpuCard } from './GpuCard.js';
import { MetricChart } from './MetricChart.js';

interface PerformanceCardsProps {
  readonly latest: TelemetrySample | null;
  readonly samples: readonly TelemetrySample[];
  readonly connection: ProbeConnectionState;
  readonly probe?: ProbeView | null;
  readonly sampleTimeMode?: 'received' | 'sampled';
}

const bytesPerGiB = 1024 ** 3;
const gpuUtilization = (sample: TelemetrySample): number | null => sample.gpuAggregate?.utilizationPct ?? null;
const vramUsedGiB = (sample: TelemetrySample): number | null => {
  const usedBytes = sample.gpuAggregate?.memoryUsedBytes ?? null;
  return usedBytes === null ? null : usedBytes / bytesPerGiB;
};
const ramUsedGiB = (sample: TelemetrySample): number => sample.ram.usedBytes / bytesPerGiB;
const diskUsedGiB = (sample: TelemetrySample): number => sample.disk.usedBytes / bytesPerGiB;
const percentLabel = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`);
const gibLabel = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)} GiB`);

export function PerformanceCards({
  latest,
  samples,
  connection,
  probe = null,
  sampleTimeMode = 'received',
}: PerformanceCardsProps): JSX.Element {
  const vramTotalBytes = latest?.gpuAggregate?.memoryTotalBytes;
  return (
    <>
      <GpuCard
        latest={latest}
        samples={samples}
        connection={connection}
        probe={probe}
        sampleTimeMode={sampleTimeMode}
      />
      <div class="charts-grid">
        <MetricChart
          title="GPU utilization"
          unit="%"
          samples={samples}
          accessor={gpuUtilization}
          color="#3794ff"
          themeColor="--vscode-charts-blue"
          yMax={100}
          valueFormatter={percentLabel}
        />
        <MetricChart
          title="VRAM"
          unit="GiB"
          samples={samples}
          accessor={vramUsedGiB}
          color="#f7b955"
          themeColor="--vscode-charts-yellow"
          yMax={vramTotalBytes ? vramTotalBytes / bytesPerGiB : 100}
          valueFormatter={gibLabel}
        />
        <MetricChart
          title="System RAM"
          unit="GiB"
          samples={samples}
          accessor={ramUsedGiB}
          color="#89d185"
          themeColor="--vscode-charts-green"
          yMax={latest ? latest.ram.totalBytes / bytesPerGiB : 100}
          valueFormatter={gibLabel}
        />
        <MetricChart
          title="Disk used"
          unit="GiB"
          samples={samples}
          accessor={diskUsedGiB}
          color="#d18616"
          themeColor="--vscode-charts-orange"
          yMax={latest ? latest.disk.totalBytes / bytesPerGiB : 100}
          valueFormatter={gibLabel}
        />
      </div>
    </>
  );
}
