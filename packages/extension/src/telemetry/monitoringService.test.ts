import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ColabDeckError } from '@colabdeck/shared';
import type { ProbeSample, ProbeStatus, ServerDescriptor } from '@colabdeck/shared';
import { readConfig } from '../config.js';
import type { Logger } from '../log.js';
import type { ProbeCommandClient } from '../probe/commandClient.js';
import type { ProbeInstaller } from '../probe/installer.js';
import type { TerminalProbeLauncher } from '../probe/launcher.js';
import type { ProbeReadResult } from '../probe/reader.js';
import type { ServerRegistry } from '../server/serverRegistry.js';
import { MonitoringService } from './monitoringService.js';
import { TelemetryStore } from './store.js';

const reader = vi.hoisted(() => ({
  read: vi.fn<() => Promise<ProbeReadResult>>(),
  readStatus: vi.fn<() => Promise<ProbeStatus>>(),
}));

vi.mock('../probe/reader.js', () => ({
  ProbeReader: class {
    readonly read = reader.read;
    readonly readStatus = reader.readStatus;
  },
}));

vi.mock('vscode', () => ({
  EventEmitter: class EventEmitter<Payload> {
    private readonly listeners = new Set<(payload: Payload) => void>();
    readonly event = (listener: (payload: Payload) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(payload: Payload): void {
      for (const listener of this.listeners) listener(payload);
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
  Uri: { from: (parts: Parameters<typeof vscode.Uri.from>[0]) => parts },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

const server: ServerDescriptor = {
  id: 'r-test',
  label: 'Colab GPU',
  source: 'mounted-folder',
  notebookUri: null,
  jupyterBaseUrl: null,
  kernelApiAvailable: false,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const active = new Set<MonitoringService>();

afterEach(() => {
  for (const service of active) service.dispose();
  active.clear();
  vi.useRealTimers();
});

function fixture() {
  const config = readConfig();
  const now = Date.now();
  const status: ProbeStatus = {
    protocol: 1,
    bootId: 'probe-test',
    vmBootId: 'vm-test',
    pid: 123,
    python: '3.12',
    startedAtMs: now,
    serverNowMs: now,
    lastSampleAtMs: now,
    seq: 1,
    sampleIntervalMs: config.sampleIntervalMs,
    probeDir: config.probeDir,
    metricsFile: 'metrics.jsonl',
    state: 'running',
    capabilities: [],
  };
  const sample: ProbeSample = {
    type: 'SAMPLE',
    protocol: 1,
    bootId: status.bootId,
    seq: status.seq,
    timestampMs: now,
    intervalMs: config.sampleIntervalMs,
    metrics: {
      gpu: { present: false, source: 'none', gpus: [], processes: [] },
      ram: { totalBytes: 100, availableBytes: 20, usedBytes: 80, source: 'procfs' },
      swap: null,
      disk: { path: '/content', totalBytes: 100, freeBytes: 20, usedBytes: 80, source: 'statvfs' },
      cpu: { count: 2, load1: 1, load5: 1, load15: 1 },
      temperature: { cpuC: null, gpuC: null, source: 'none' },
    },
    errors: [],
  };
  reader.read.mockReset().mockResolvedValue({ status, samples: [sample], reset: false });
  reader.readStatus.mockReset().mockResolvedValue(status);
  const registry = {
    all: [server],
    currentId: server.id,
    selected: () => server,
    validateServer: vi.fn().mockResolvedValue(true),
  };
  const install = vi.fn<ProbeInstaller['install']>().mockResolvedValue(undefined);
  const findRunningProbe = vi.fn<TerminalProbeLauncher['findRunningProbe']>().mockResolvedValue(null);
  const requireTerminal = vi.fn<TerminalProbeLauncher['requireTerminal']>().mockReturnValue({} as vscode.Terminal);
  const launch = vi.fn<TerminalProbeLauncher['launch']>().mockResolvedValue(status);
  const stopProbe = vi.fn<ProbeCommandClient['stop']>().mockResolvedValue(true);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new MonitoringService(
    logger as unknown as Logger,
    registry as unknown as ServerRegistry,
    { install } as unknown as ProbeInstaller,
    { findRunningProbe, requireTerminal, launch } as unknown as TerminalProbeLauncher,
    { stop: stopProbe } as unknown as ProbeCommandClient,
    new TelemetryStore(config.sampleIntervalMs),
    () => config,
  );
  active.add(service);
  const onError = vi.fn();
  service.onError(onError);
  return { service, status, install, findRunningProbe, requireTerminal, launch, stopProbe, onError };
}

describe('MonitoringService lifecycle', () => {
  it('retries a failed terminal preflight without sending STOP', async () => {
    const { service, requireTerminal, install, launch, stopProbe } = fixture();
    requireTerminal.mockImplementationOnce(() => {
      throw new ColabDeckError('Open the matching Colab terminal first.', {
        code: 'PROBE_LAUNCH_FAILED', recoverable: true, action: 'RETRY',
      });
    });

    await service.start();
    expect(service.getConnection()).toBe('error');
    expect(install).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();

    await service.start();
    expect(service.getConnection()).toBe('connected');
    expect(service.getLatestSample()?.seq).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(stopProbe).not.toHaveBeenCalled();
  });

  it('coalesces concurrent starts for the same server and starts the sampler', async () => {
    vi.useFakeTimers();
    const { service, status, install, launch, stopProbe } = fixture();
    const started = deferred();
    const pending = deferred();
    install.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });

    const first = service.start(server);
    await started.promise;
    const duplicate = service.start({ ...server });
    pending.resolve();
    await Promise.all([first, duplicate]);

    expect(service.getConnection()).toBe('connected');
    expect(install).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(stopProbe).not.toHaveBeenCalled();
    const firstReadCount = reader.read.mock.calls.length;
    expect(firstReadCount).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(status.sampleIntervalMs);
    expect(reader.read).toHaveBeenCalledTimes(firstReadCount + 1);
  });

  it('cancels pending installation without launching, sending STOP, or reporting an error', async () => {
    const { service, install, launch, stopProbe, onError } = fixture();
    const started = deferred();
    const pending = deferred();
    install.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });

    const start = service.start();
    await started.promise;
    service.stop(false);
    expect(install.mock.calls[0]?.[2]?.aborted).toBe(true);
    pending.reject(new Error('Provider completed after cancellation'));
    await start;

    expect(service.getConnection()).toBe('disconnected');
    expect(service.status.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(stopProbe).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('attaches to a fresh running probe without requiring a terminal or reinstalling', async () => {
    const { service, status, findRunningProbe, requireTerminal, install, launch, stopProbe } = fixture();
    findRunningProbe.mockResolvedValueOnce(status);
    requireTerminal.mockImplementation(() => { throw new Error('No terminal is open'); });

    await service.start();

    expect(service.getConnection()).toBe('connected');
    expect(service.status.probe?.bootId).toBe(status.bootId);
    expect(service.getLatestSample()?.seq).toBe(status.seq);
    expect(requireTerminal).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(stopProbe).not.toHaveBeenCalled();
  });
});
