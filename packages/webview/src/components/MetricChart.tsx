import { memo } from 'preact/compat';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import uPlot from 'uplot';
import type { TelemetrySample } from '@colabdeck/shared';

interface MetricChartProps {
  readonly title: string;
  readonly unit: string;
  readonly samples: readonly TelemetrySample[];
  readonly accessor: (sample: TelemetrySample) => number | null;
  /** Fallback color when the theme variable is unavailable. */
  readonly color: string;
  /** VS Code chart color variable, for example --vscode-charts-blue. */
  readonly themeColor?: string;
  readonly yMax?: number;
  readonly valueFormatter?: (value: number | null) => string;
}

function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

// Below this width the plot area would collapse after the y-axis and padding.
const MIN_CHART_WIDTH = 120;

function chartWidth(container: HTMLElement): number {
  return Math.max(MIN_CHART_WIDTH, container.clientWidth);
}

export const MetricChart = memo(function MetricChart({
  title,
  unit,
  samples,
  accessor,
  color,
  themeColor,
  yMax,
  valueFormatter,
}: MetricChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const latestValue = latest ? accessor(latest) : null;
  // A formatter owns the whole label (units included); the unit is only appended to the bare number.
  const formatValue = (value: number | null): string =>
    valueFormatter
      ? valueFormatter(value)
      : `${value === null ? '—' : value.toFixed(1)}${unit ? ` ${unit}` : ''}`;
  const latestText = formatValue(latestValue);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const width = chartWidth(container);
    const seriesColor = themeColor ? readCssVar(themeColor, color) : color;
    const axisColor = readCssVar('--vscode-descriptionForeground', '#6b7280');
    const gridColor = readCssVar('--vscode-charts-lines', 'rgba(128,128,128,0.18)');
    const options: uPlot.Options = {
      width,
      height: 128,
      padding: [8, 18, 4, 4],
      scales: { x: { time: true }, y: yMax === undefined ? {} : { range: [0, yMax] } },
      axes: [
        {
          show: true,
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          values: (_self: uPlot, splits: number[]) =>
            splits.map((value) =>
              new Date(value * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            ),
        },
        { show: true, size: 38, stroke: axisColor, grid: { stroke: gridColor, width: 1 } },
      ],
      series: [
        {},
        {
          stroke: seriesColor,
          width: 1.6,
          spanGaps: false,
          points: { show: false },
        },
      ],
      legend: { show: false },
      cursor: { show: true, lock: false },
      hooks: {
        setCursor: [
          (chart) => {
            const tooltip = tooltipRef.current;
            if (!tooltip) {
              return;
            }
            const idx = chart.cursor.idx;
            if (idx === null || idx === undefined) {
              tooltip.classList.remove('visible');
              return;
            }
            const xValues = chart.data[0] as number[];
            const yValues = chart.data[1] as (number | null | undefined)[];
            const timestamp = xValues[idx];
            if (timestamp === undefined) {
              tooltip.classList.remove('visible');
              return;
            }
            const time = new Date(timestamp * 1000).toLocaleTimeString([], { hour12: false });
            tooltip.textContent = `${time} · ${formatValue(yValues[idx] ?? null)}`;
            // cursor.left is relative to the plotting area, which starts after the y-axis and padding.
            tooltip.style.left = `${(chart.cursor.left ?? 0) + 42}px`;
            tooltip.classList.add('visible');
          },
        ],
      },
    };
    const xs = samples.map((sample) => sample.timestampMs / 1000);
    const ys = samples.map((sample) => accessor(sample));
    const chart = new uPlot(options, [xs, ys] as unknown as uPlot.AlignedData, container);
    chartRef.current = chart;
    const hideTooltip = (): void => tooltipRef.current?.classList.remove('visible');
    container.addEventListener('mouseleave', hideTooltip);
    const observer = new ResizeObserver(() => {
      const nextWidth = chartWidth(container);
      chart.setSize({ width: nextWidth, height: 128 });
    });
    observer.observe(container);
    return () => {
      container.removeEventListener('mouseleave', hideTooltip);
      observer.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
    // The chart instance is intentionally stable; data updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, themeColor, yMax]);

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
      <div class="chart-plot">
        <div class="chart-canvas" ref={containerRef} />
        <div class="chart-tooltip" ref={tooltipRef} aria-hidden="true" />
      </div>
    </section>
  );
});
