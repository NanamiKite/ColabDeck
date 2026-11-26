import { describe, expect, it } from 'vitest';
import type { ProbeSample } from './protocol/probe.js';
import { aggregateGpus, downsampleTelemetry, toTelemetrySample } from './telemetry.js';

function sample(seq: number, utilizationPct: number, timestampMs = seq * 5_000): ProbeSample {
  return {
    type: 'SAMPLE',
    protocol: 1,
    bootId: 'boot-1',
    seq,
    timestampMs,
    intervalMs: 5_000,
    metrics: {
      gpu: {
        present: true,
        source: 'nvidia-smi',
        gpus: [
          {
            index: 0,
            name: 'Tesla T4',
            utilizationPct,
            memoryUsedBytes: utilizationPct * 1_000_000,
            memoryTotalBytes: 15_000_000_000,
            memoryPeakBytes: null,
            temperatureC: 60,
            powerWatts: 50,
          },
        ],
        processes: [],
      },
      ram: { totalBytes: 100, availableBytes: 40, usedBytes: 60, source: 'procfs' },
      swap: null,
      disk: { path: '/content/.colabdeck', totalBytes: 1000, freeBytes: 500, usedBytes: 500, source: 'statvfs' },
      cpu: { count: 2, load1: 1, load5: 1, load15: 1 },
      temperature: { cpuC: 50, gpuC: 60, source: 'nvidia-smi' },
    },
    errors: [],
  };
}

describe('telemetry', () => {
  it('maps probe samples and aggregates GPU maxima', () => {
    const telemetry = toTelemetrySample(sample(1, 42), 123);
    expect(telemetry.seq).toBe(1);
    expect(telemetry.receivedAtMs).toBe(123);
    expect(telemetry.gpuAggregate?.utilizationPct).toBe(42);
    expect(telemetry.gpuAggregate?.shortName).toBe('T4');
    expect(aggregateGpus(telemetry.gpus)?.memoryUsedBytes).toBe(42_000_000);
  });

  it('downsamples while preserving peak VRAM', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seq) =>
      toTelemetrySample(sample(seq, seq * 10), seq * 5_000),
    );
    const reduced = downsampleTelemetry(samples, 3);
    expect(reduced).toHaveLength(3);
    expect(reduced[0]?.gpuAggregate?.memoryUsedBytes).toBe(30_000_000);
    expect(reduced[1]?.gpuAggregate?.memoryUsedBytes).toBe(60_000_000);
    expect(reduced[2]?.gpuAggregate?.memoryUsedBytes).toBe(100_000_000);
  });
});
