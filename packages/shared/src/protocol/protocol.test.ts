import { describe, expect, it } from 'vitest';
import { probeSampleSchema } from './probe.js';
import { timeRangeToMs, WEBVIEW_PROTOCOL_VERSION, webviewToHostMessageSchema } from './webview.js';

describe('protocol schemas', () => {
  it('maps dashboard time ranges to milliseconds', () => {
    expect(timeRangeToMs('15m')).toBe(900_000);
    expect(timeRangeToMs('30m')).toBe(1_800_000);
    expect(timeRangeToMs('1h')).toBe(3_600_000);
  });

  it('accepts a minimal valid probe sample and rejects unknown fields', () => {
    const sample = {
      type: 'SAMPLE',
      protocol: 1,
      bootId: 'boot-1',
      seq: 1,
      timestampMs: 1,
      intervalMs: 5000,
      metrics: {
        gpu: { present: false, source: 'none', gpus: [], processes: [] },
        ram: { totalBytes: 1, availableBytes: 1, usedBytes: 0, source: 'procfs' },
        swap: null,
        disk: { path: '/content/.colabdeck', totalBytes: 1, freeBytes: 1, usedBytes: 0, source: 'statvfs' },
        cpu: { count: 1, load1: 0, load5: 0, load15: 0 },
        temperature: { cpuC: null, gpuC: null, source: 'none' },
      },
      errors: [],
    };
    expect(probeSampleSchema.safeParse(sample).success).toBe(true);
    expect(probeSampleSchema.safeParse({ ...sample, unexpected: true }).success).toBe(false);
  });

  it('validates webview inbound messages', () => {
    expect(webviewToHostMessageSchema.safeParse({ type: 'READY', protocol: 1 }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'READY', protocol: WEBVIEW_PROTOCOL_VERSION }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'MOUNT_COLAB_SERVER' }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'REFRESH_SERVERS' }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'START_MONITORING' }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'RETRY_PROBE' }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'RELOAD_WINDOW' }).success).toBe(false);
    expect(webviewToHostMessageSchema.safeParse({ type: 'KILL_PROCESS', requestId: 'x', pid: 0 }).success).toBe(false);
    expect(
      webviewToHostMessageSchema.safeParse({
        type: 'IDLE_GUARD_CANCEL',
        requestId: 'x',
        source: 'webview',
      }).success,
    ).toBe(true);
  });
});
