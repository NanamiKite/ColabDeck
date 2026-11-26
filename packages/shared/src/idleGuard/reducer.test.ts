import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '../protocol/webview.js';
import {
  createInitialIdleGuardState,
  reduceIdleGuard,
  type IdleGuardSettings,
  type IdleGuardState,
} from './reducer.js';

const settings: IdleGuardSettings = {
  enabled: true,
  gpuUtilizationThresholdPct: 5,
  idleDebounceMs: 5_000,
  idleThresholdMs: 5 * 60_000,
  countdownMs: 120_000,
  staleSampleMs: 15_000,
  minRuntimeMs: 5 * 60_000,
  snoozeMs: 30 * 60_000,
  autoRelease: true,
  requireKernelIdle: 'auto',
};

function makeSample(utilizationPct: number | null, seq = 1, timestampMs = 0): TelemetrySample {
  const gpus =
    utilizationPct === null
      ? []
      : [
          {
            index: 0,
            name: 'Tesla T4',
            utilizationPct,
            memoryUsedBytes: 1024 * 1024 * 1024,
            memoryTotalBytes: 15 * 1024 * 1024 * 1024,
            temperatureC: 60,
            powerWatts: 50,
          },
        ];
  return {
    seq,
    timestampMs,
    receivedAtMs: timestampMs,
    gpus,
    gpuAggregate:
      gpus.length === 0
        ? null
        : {
            count: 1,
            shortName: 'T4',
            utilizationPct,
            memoryUsedBytes: 1024 * 1024 * 1024,
            memoryTotalBytes: 15 * 1024 * 1024 * 1024,
            temperatureC: 60,
            powerWatts: 50,
          },
    ram: { totalBytes: 100, availableBytes: 40, usedBytes: 60 },
    disk: { path: '/content/.colabdeck', totalBytes: 1000, freeBytes: 500, usedBytes: 500 },
    cpu: { count: 2, load1: 1, load5: 1, load15: 1 },
    temperature: { cpuC: 50, gpuC: 60 },
    errors: [],
  };
}

function connect(now = 0): IdleGuardState {
  const enabled = reduceIdleGuard(
    createInitialIdleGuardState(),
    { type: 'SETTINGS_ENABLED' },
    settings,
    now,
  ).state;
  const connected = reduceIdleGuard(
    enabled,
    {
      type: 'SERVER_CONNECTED',
      serverId: 'server-1',
      serverLabel: 'T4 runtime',
      gpuPresent: true,
      connectedAtMs: now,
    },
    settings,
    now,
  ).state;
  return reduceIdleGuard(
    connected,
    { type: 'SAMPLE_RECEIVED', sample: makeSample(50, 1, now), sampleAgeMs: 0, kernelBusy: null },
    settings,
    now,
  ).state;
}

function lowSample(now: number, seq: number, kernelBusy: boolean | null = null): IdleGuardState {
  return reduceIdleGuard(
    connect(0),
    { type: 'SAMPLE_RECEIVED', sample: makeSample(0, seq, now), sampleAgeMs: 0, kernelBusy },
    settings,
    now,
  ).state;
}

function enterCountdown(): IdleGuardState {
  const at = 6 * 60_000;
  let state = lowSample(at, 2);
  state = reduceIdleGuard(
    state,
    { type: 'SAMPLE_RECEIVED', sample: makeSample(0, 3, at + 5_000), sampleAgeMs: 0, kernelBusy: null },
    settings,
    at + 5_000,
  ).state;
  expect(state.status).toBe('IDLE_DETECTED');
  return reduceIdleGuard(state, { type: 'IDLE_THRESHOLD_REACHED' }, settings, at + 5_000).state;
}

describe('Idle Guard reducer', () => {
  it('connects, detects idle, starts countdown and cancels back to active', () => {
    const state = enterCountdown();
    expect(state.status).toBe('COUNTDOWN_WARNING');
    const cancelled = reduceIdleGuard(
      state,
      { type: 'CANCEL', source: 'webview' },
      settings,
      state.lastTransitionAtMs + 1_000,
    );
    expect(cancelled.state.status).toBe('ACTIVE');
    expect(cancelled.state.idleSinceMs).toBeNull();
    expect(cancelled.state.countdownEndsAtMs).toBeNull();
    expect(cancelled.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(false);
  });

  it('stays ACTIVE during the runtime grace period', () => {
    const state = lowSample(60_000, 2);
    expect(state.status).toBe('ACTIVE');
    expect(state.idleSinceMs).toBeNull();
  });

  it('debounces the first low sample before entering IDLE_DETECTED', () => {
    const state = lowSample(6 * 60_000, 2);
    expect(state.status).toBe('ACTIVE');
    expect(state.idleSinceMs).toBe(6 * 60_000);
  });

  it('goes DISCONNECTED on stale samples and never invokes release', () => {
    const result = reduceIdleGuard(
      connect(0),
      {
        type: 'SAMPLE_RECEIVED',
        sample: makeSample(0, 2, 20_000),
        sampleAgeMs: 20_000,
        kernelBusy: null,
      },
      settings,
      20_000,
    );
    expect(result.state.status).toBe('DISCONNECTED');
    expect(result.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(false);
  });

  it('keeps COUNTDOWN_WARNING when autoRelease is disabled', () => {
    const state = enterCountdown();
    const result = reduceIdleGuard(state, { type: 'COUNTDOWN_EXPIRED' }, { ...settings, autoRelease: false }, 500_000);
    expect(result.state.status).toBe('COUNTDOWN_WARNING');
    expect(result.state.phase).toBe('expired');
    expect(result.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(false);
  });

  it('suppresses automatic release when the kernel is known busy', () => {
    const state = enterCountdown();
    const withBusyKernel = { ...state, kernelBusy: true };
    const result = reduceIdleGuard(withBusyKernel, { type: 'COUNTDOWN_EXPIRED' }, settings, 500_000);
    expect(result.state.status).toBe('COUNTDOWN_WARNING');
    expect(result.state.phase).toBe('kernel-busy');
    expect(result.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(false);
  });

  it('suppresses release in always mode when kernel status is unknown', () => {
    const state = { ...enterCountdown(), kernelBusy: null };
    const result = reduceIdleGuard(
      state,
      { type: 'COUNTDOWN_EXPIRED' },
      { ...settings, requireKernelIdle: 'always' },
      500_000,
    );
    expect(result.state.phase).toBe('kernel-busy');
    expect(result.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(false);
  });

  it('releases in never mode even when the kernel is busy', () => {
    const state = { ...enterCountdown(), kernelBusy: true };
    const result = reduceIdleGuard(
      state,
      { type: 'COUNTDOWN_EXPIRED' },
      { ...settings, requireKernelIdle: 'never' },
      500_000,
    );
    expect(result.state.status).toBe('TERMINATING');
    expect(result.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(true);
  });

  it('treats unknown kernel status as not busy in auto mode', () => {
    const state = { ...enterCountdown(), kernelBusy: null };
    const result = reduceIdleGuard(state, { type: 'COUNTDOWN_EXPIRED' }, settings, 500_000);
    expect(result.state.status).toBe('TERMINATING');
    expect(result.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(true);
  });

  it('TERMINATING absorbs probe loss until the release result arrives', () => {
    const state = enterCountdown();
    const terminating = reduceIdleGuard(state, { type: 'COUNTDOWN_EXPIRED' }, settings, 500_000).state;
    const lost = reduceIdleGuard(
      terminating,
      { type: 'PROBE_LOST', reason: 'probe disappeared during release' },
      settings,
      501_000,
    );
    expect(lost.state.status).toBe('TERMINATING');
    const succeeded = reduceIdleGuard(lost.state, { type: 'RELEASE_SUCCEEDED' }, settings, 502_000);
    expect(succeeded.state.status).toBe('TERMINATED');
  });

  it('DISABLED absorbs runtime events', () => {
    let state = createInitialIdleGuardState();
    state = reduceIdleGuard(
      state,
      {
        type: 'SERVER_CONNECTED',
        serverId: 'server-1',
        serverLabel: 'T4',
        gpuPresent: true,
        connectedAtMs: 0,
      },
      settings,
      0,
    ).state;
    state = reduceIdleGuard(state, { type: 'PROBE_LOST', reason: 'x' }, settings, 1).state;
    expect(state.status).toBe('DISABLED');
  });

  it('handles release cancel, failure and retry', () => {
    const state = enterCountdown();
    const terminating = reduceIdleGuard(state, { type: 'COUNTDOWN_EXPIRED' }, settings, 500_000).state;
    const cancelled = reduceIdleGuard(
      terminating,
      { type: 'RELEASE_CANCELLED', reason: 'user dismissed QuickPick' },
      settings,
      501_000,
    );
    expect(cancelled.state.status).toBe('ACTIVE');

    const failed = reduceIdleGuard(
      terminating,
      { type: 'RELEASE_FAILED', message: 'command unavailable' },
      settings,
      501_000,
    );
    expect(failed.state.status).toBe('ERROR');
    const retried = reduceIdleGuard(failed.state, { type: 'RETRY' }, settings, 502_000);
    expect(retried.state.status).toBe('SYNCING');
  });

  it('snoozes from countdown into ACTIVE without releasing', () => {
    const state = enterCountdown();
    const result = reduceIdleGuard(
      state,
      { type: 'SNOOZE', durationMs: 30 * 60_000, source: 'webview' },
      settings,
      400_000,
    );
    expect(result.state.status).toBe('ACTIVE');
    expect(result.state.snoozedUntilMs).toBe(400_000 + 30 * 60_000);
    expect(result.effects.some((effect) => effect.type === 'INVOKE_RELEASE')).toBe(false);
  });

  it('marks CPU-only runtimes UNSUPPORTED', () => {
    const enabled = reduceIdleGuard(
      createInitialIdleGuardState(),
      { type: 'SETTINGS_ENABLED' },
      settings,
      0,
    ).state;
    const connected = reduceIdleGuard(
      enabled,
      {
        type: 'SERVER_CONNECTED',
        serverId: 'server-1',
        serverLabel: 'CPU runtime',
        gpuPresent: false,
        connectedAtMs: 0,
      },
      settings,
      0,
    ).state;
    const result = reduceIdleGuard(
      connected,
      { type: 'SAMPLE_RECEIVED', sample: makeSample(null, 1, 0), sampleAgeMs: 0, kernelBusy: null },
      settings,
      0,
    );
    expect(result.state.status).toBe('UNSUPPORTED');
  });

  it('recovers to ACTIVE when utilization returns during countdown', () => {
    const state = enterCountdown();
    const result = reduceIdleGuard(
      state,
      { type: 'SAMPLE_RECEIVED', sample: makeSample(80, 9, 400_000), sampleAgeMs: 0, kernelBusy: null },
      settings,
      400_000,
    );
    expect(result.state.status).toBe('ACTIVE');
    expect(result.state.countdownEndsAtMs).toBeNull();
  });

  it('disables from countdown and cancels timers', () => {
    const state = enterCountdown();
    const result = reduceIdleGuard(state, { type: 'SETTINGS_DISABLED' }, settings, 400_000);
    expect(result.state.status).toBe('DISABLED');
    expect(result.state.countdownEndsAtMs).toBeNull();
  });
});
