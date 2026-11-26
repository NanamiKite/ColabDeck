import type {
  GpuAggregate,
  GpuSample,
  TelemetrySample,
} from './protocol/webview.js';
import type { ProbeSample } from './protocol/probe.js';
import { gpuAggregateShortName, gpuShortName } from './format.js';

export function toTelemetrySample(sample: ProbeSample, receivedAtMs: number): TelemetrySample {
  const gpus: GpuSample[] = sample.metrics.gpu.gpus.map((gpu) => ({
    index: gpu.index,
    name: gpu.name,
    utilizationPct: gpu.utilizationPct,
    memoryUsedBytes: gpu.memoryUsedBytes,
    memoryTotalBytes: gpu.memoryTotalBytes,
    temperatureC: gpu.temperatureC,
    powerWatts: gpu.powerWatts,
  }));
  return {
    seq: sample.seq,
    timestampMs: sample.timestampMs,
    receivedAtMs,
    gpus,
    gpuAggregate: aggregateGpus(gpus),
    ram: {
      totalBytes: sample.metrics.ram.totalBytes,
      availableBytes: sample.metrics.ram.availableBytes,
      usedBytes: sample.metrics.ram.usedBytes,
    },
    disk: {
      path: sample.metrics.disk.path,
      totalBytes: sample.metrics.disk.totalBytes,
      freeBytes: sample.metrics.disk.freeBytes,
      usedBytes: sample.metrics.disk.usedBytes,
    },
    cpu: {
      count: sample.metrics.cpu.count,
      load1: sample.metrics.cpu.load1,
      load5: sample.metrics.cpu.load5,
      load15: sample.metrics.cpu.load15,
    },
    temperature: {
      cpuC: sample.metrics.temperature.cpuC,
      gpuC: sample.metrics.temperature.gpuC,
    },
    errors: sample.errors.map((error) => `${error.metric}: ${error.message}`),
  };
}

export function aggregateGpus(gpus: readonly GpuSample[]): GpuAggregate | null {
  if (gpus.length === 0) {
    return null;
  }
  const utilizationValues = gpus
    .map((gpu) => gpu.utilizationPct)
    .filter((value): value is number => value !== null);
  const usedValues = gpus
    .map((gpu) => gpu.memoryUsedBytes)
    .filter((value): value is number => value !== null);
  const totalValues = gpus
    .map((gpu) => gpu.memoryTotalBytes)
    .filter((value): value is number => value !== null);
  const temperatureValues = gpus
    .map((gpu) => gpu.temperatureC)
    .filter((value): value is number => value !== null);
  const powerValues = gpus
    .map((gpu) => gpu.powerWatts)
    .filter((value): value is number => value !== null);

  return {
    count: gpus.length,
    shortName: gpuAggregateShortName(gpus.map((gpu) => gpu.name)),
    utilizationPct: utilizationValues.length === 0 ? null : Math.max(...utilizationValues),
    memoryUsedBytes: usedValues.length === 0 ? null : usedValues.reduce((sum, value) => sum + value, 0),
    memoryTotalBytes: totalValues.length === 0 ? null : totalValues.reduce((sum, value) => sum + value, 0),
    temperatureC: temperatureValues.length === 0 ? null : Math.max(...temperatureValues),
    powerWatts: powerValues.length === 0 ? null : powerValues.reduce((sum, value) => sum + value, 0),
  };
}

export function computeWindowPeakMemory(samples: readonly TelemetrySample[]): number | null {
  let peak: number | null = null;
  for (const sample of samples) {
    for (const gpu of sample.gpus) {
      if (gpu.memoryUsedBytes !== null && (peak === null || gpu.memoryUsedBytes > peak)) {
        peak = gpu.memoryUsedBytes;
      }
    }
    if (sample.gpuAggregate?.memoryUsedBytes !== null && sample.gpuAggregate?.memoryUsedBytes !== undefined) {
      if (peak === null || sample.gpuAggregate.memoryUsedBytes > peak) {
        peak = sample.gpuAggregate.memoryUsedBytes;
      }
    }
  }
  return peak;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

function nonNull<T>(values: readonly (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}

function aggregateBucket(samples: readonly TelemetrySample[]): TelemetrySample {
  const last = samples[samples.length - 1];
  if (!last) {
    throw new Error('aggregateBucket requires at least one sample');
  }
  const gpuIndexes = [...new Set(samples.flatMap((sample) => sample.gpus.map((gpu) => gpu.index)))].sort(
    (a, b) => a - b,
  );
  const gpus: GpuSample[] = gpuIndexes.map((index) => {
    const entries = samples.flatMap((sample) => sample.gpus.filter((gpu) => gpu.index === index));
    const first = entries[0];
    return {
      index,
      name: first?.name ?? 'GPU',
      utilizationPct: average(nonNull(entries.map((gpu) => gpu.utilizationPct))),
      memoryUsedBytes: max(nonNull(entries.map((gpu) => gpu.memoryUsedBytes))),
      memoryTotalBytes: max(nonNull(entries.map((gpu) => gpu.memoryTotalBytes))),
      temperatureC: max(nonNull(entries.map((gpu) => gpu.temperatureC))),
      powerWatts: max(nonNull(entries.map((gpu) => gpu.powerWatts))),
    };
  });
  const errors = [...new Set(samples.flatMap((sample) => sample.errors))];
  const cpuTemps = nonNull(samples.map((sample) => sample.temperature.cpuC));
  const gpuTemps = nonNull(samples.map((sample) => sample.temperature.gpuC));
  return {
    seq: last.seq,
    timestampMs: last.timestampMs,
    receivedAtMs: last.receivedAtMs,
    gpus,
    gpuAggregate: aggregateGpus(gpus),
    ram: {
      totalBytes: last.ram.totalBytes,
      availableBytes: Math.min(...samples.map((sample) => sample.ram.availableBytes)),
      usedBytes: Math.max(...samples.map((sample) => sample.ram.usedBytes)),
    },
    disk: {
      path: last.disk.path,
      totalBytes: last.disk.totalBytes,
      freeBytes: Math.min(...samples.map((sample) => sample.disk.freeBytes)),
      usedBytes: Math.max(...samples.map((sample) => sample.disk.usedBytes)),
    },
    cpu: last.cpu,
    temperature: {
      cpuC: max(cpuTemps),
      gpuC: max(gpuTemps),
    },
    errors,
  };
}

/**
 * Downsamples telemetry while preserving peaks for memory and temperature.
 * Utilization is averaged per bucket; VRAM/free space keep the worst observed value.
 */
export function downsampleTelemetry(
  samples: readonly TelemetrySample[],
  maxPoints: number,
): readonly TelemetrySample[] {
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
    return [];
  }
  if (samples.length <= maxPoints) {
    return samples;
  }
  const result: TelemetrySample[] = [];
  for (let bucketIndex = 0; bucketIndex < maxPoints; bucketIndex += 1) {
    const start = Math.floor((bucketIndex * samples.length) / maxPoints);
    const end = Math.max(start + 1, Math.floor(((bucketIndex + 1) * samples.length) / maxPoints));
    result.push(aggregateBucket(samples.slice(start, end)));
  }
  return result;
}

export function telemetryWindow(
  samples: readonly TelemetrySample[],
  rangeMs: number,
  nowMs: number,
): readonly TelemetrySample[] {
  const cutoff = nowMs - rangeMs;
  return samples.filter((sample) => sample.timestampMs >= cutoff);
}

export function gpuNameFromAggregate(aggregate: GpuAggregate | null): string {
  if (!aggregate) {
    return 'No GPU';
  }
  return aggregate.count === 1 ? gpuShortName(aggregate.shortName) : aggregate.shortName;
}
