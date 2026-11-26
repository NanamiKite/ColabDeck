import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from './protocol/webview.js';
import { mergeTelemetrySamples, replaceTelemetrySamples } from './telemetry.js';

function sample(timestampMs: number, seq: number, receivedAtMs = timestampMs + 10): TelemetrySample {
  return {
    seq,
    timestampMs,
    receivedAtMs,
    gpus: [],
    gpuAggregate: null,
    ram: { totalBytes: 0, availableBytes: 0, usedBytes: 0 },
    disk: { path: '/content', totalBytes: 0, freeBytes: 0, usedBytes: 0 },
    cpu: { count: 1, load1: 0, load5: 0, load15: 0 },
    temperature: { cpuC: null, gpuC: null },
    errors: [],
  };
}

describe('mergeTelemetrySamples', () => {
  it('keeps samples from before and after a probe restart when seq restarts at 1', () => {
    const beforeRestart = [sample(1_000, 1), sample(2_000, 2)];
    const afterRestart = [sample(3_000, 1), sample(4_000, 2)];

    const merged = mergeTelemetrySamples(beforeRestart, afterRestart, null, 5_000);

    expect(merged.map((item) => item.timestampMs)).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  it('prefers the newer copy when the same timestamp arrives twice', () => {
    const first = sample(1_000, 7, 1_010);
    const again = sample(1_000, 7, 1_050);

    const merged = mergeTelemetrySamples([first], [again], null, 5_000);

    expect(merged).toHaveLength(1);
    expect(merged[0].receivedAtMs).toBe(1_050);
  });

  it('drops samples older than the range and caps the buffer size', () => {
    const now = 100_000;
    const history = Array.from({ length: 10 }, (_, index) => sample(now - 9_000 + index * 1_000, index));

    const merged = mergeTelemetrySamples(history, [sample(now, 99)], 5_000, now, 4);

    expect(merged).toHaveLength(4);
    expect(merged.map((item) => item.timestampMs)).toEqual([now - 3_000, now - 2_000, now - 1_000, now]);
    expect(merged[merged.length - 1].timestampMs).toBe(now);
  });

  it('returns the current buffer when nothing arrives', () => {
    const current = [sample(1_000, 1)];

    expect(mergeTelemetrySamples(current, [], null, 5_000)).toBe(current);
  });
});

describe('replaceTelemetrySamples', () => {
  it('replaces the buffer with an authoritative batch', () => {
    const stale = [sample(1_000, 1), sample(2_000, 2)];
    const batch = [sample(3_000, 3), sample(4_000, 4)];

    expect(replaceTelemetrySamples(stale, batch).map((item) => item.timestampMs)).toEqual([3_000, 4_000]);
  });

  it('keeps samples that were streamed after the batch was cut', () => {
    const streamed = [sample(1_000, 1), sample(5_000, 5)];
    const batch = [sample(2_000, 2), sample(4_000, 4)];

    expect(replaceTelemetrySamples(streamed, batch).map((item) => item.timestampMs)).toEqual([2_000, 4_000, 5_000]);
  });

  it('keeps the current buffer when the batch is empty', () => {
    const current = [sample(1_000, 1)];

    expect(replaceTelemetrySamples(current, [])).toBe(current);
  });
});
