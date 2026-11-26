import { describe, expect, it } from 'vitest';
import { probeSampleSchema } from './probe.js';
import { webviewToHostMessageSchema } from './webview.js';

describe('protocol schemas', () => {
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
    expect(webviewToHostMessageSchema.safeParse({ type: 'READY', protocol: 2 }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'MOUNT_COLAB_SERVER' }).success).toBe(true);
    expect(webviewToHostMessageSchema.safeParse({ type: 'RELOAD_WINDOW' }).success).toBe(true);
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
