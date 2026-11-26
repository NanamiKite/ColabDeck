import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import uPlot from 'uplot';
import type { TelemetrySample } from '@colabdeck/shared';

interface MetricChartProps {
  readonly title: string;
  readonly unit: string;
  readonly samples: readonly TelemetrySample[];
  readonly accessor: (sample: TelemetrySample) => number | null;
  readonly color: string;
  readonly yMax?: number;
  readonly valueFormatter?: (value: number | null) => string;
}

export function MetricChart({
  title,
  unit,
  samples,
  accessor,
  color,
  yMax,
  valueFormatter,
}: MetricChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const latestValue = latest ? accessor(latest) : null;
  // A formatter owns the whole label (units included); the unit is only appended to the bare number.
  const latestText = valueFormatter
    ? valueFormatter(latestValue)
    : `${latestValue === null ? '—' : latestValue.toFixed(1)}${unit ? ` ${unit}` : ''}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const width = Math.max(220, container.clientWidth);
    const options: uPlot.Options = {
      width,
      height: 128,
      padding: [8, 8, 4, 4],
      scales: { x: { time: true }, y: yMax === undefined ? {} : { range: [0, yMax] } },
      axes: [
        {
          show: true,
          stroke: '#6b7280',
          grid: { stroke: 'rgba(128,128,128,0.18)', width: 1 },
          values: (_self: uPlot, splits: number[]) =>
            splits.map((value) =>
              new Date(value * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            ),
        },
        { show: true, size: 38, stroke: '#6b7280', grid: { stroke: 'rgba(128,128,128,0.18)', width: 1 } },
      ],
      series: [
        {},
        {
          stroke: color,
          width: 1.6,
          spanGaps: false,
          points: { show: false },
        },
      ],
      legend: { show: false },
      cursor: { show: true, lock: false },
    };
    const xs = samples.map((sample) => sample.timestampMs / 1000);
    const ys = samples.map((sample) => accessor(sample));
    const chart = new uPlot(options, [xs, ys] as unknown as uPlot.AlignedData, container);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      const nextWidth = Math.max(220, container.clientWidth);
      chart.setSize({ width: nextWidth, height: 128 });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
    // The chart instance is intentionally stable; data updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, yMax]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    const xs = samples.map((sample) => sample.timestampMs / 1000);
    const ys = samples.map((sample) => accessor(sample));
    chart.setData([xs, ys] as unknown as uPlot.AlignedData);
  }, [samples, accessor]);

  return (
    <section class="chart-card">
      <div class="chart-head">
        <span class="chart-title">{title}</span>
        <span class="chart-value">{latestText}</span>
      </div>
      <div class="chart-canvas" ref={containerRef} />
    </section>
  );
}
