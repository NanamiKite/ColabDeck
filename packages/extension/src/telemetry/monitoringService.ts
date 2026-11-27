import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { ColabDeckError, toTelemetrySample } from '@colabdeck/shared';
import type { ProbeStatus, ProbeView, ServerDescriptor, TelemetrySample } from '@colabdeck/shared';
import type { ColabDeckConfig } from '../config.js';
import type { Logger } from '../log.js';
import { ProbeCommandClient } from '../probe/commandClient.js';
import { ProbeInstaller } from '../probe/installer.js';
import { TerminalProbeLauncher } from '../probe/launcher.js';
import { buildProbePaths, type ProbePaths } from '../probe/probePaths.js';
import { ProbeReader } from '../probe/reader.js';
import type { ServerRegistry } from '../server/serverRegistry.js';
import { TelemetryStore } from './store.js';

export type MonitoringConnection = 'disconnected' | 'syncing' | 'connected' | 'stale' | 'error';

export interface MonitoringStatus {
  readonly serverId: string | null;
  readonly connection: MonitoringConnection;
  readonly probe: ProbeView | null;
  readonly lastSampleAtMs: number | null;
  readonly error: ColabDeckError | null;
}

interface StartOperation {
  readonly serverId: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export class MonitoringService implements vscode.Disposable {
  private current: ServerDescriptor | null = null;
  private paths: ProbePaths | null = null;
  private running: ProbeStatus | null = null;
  private reader: ProbeReader | null = null;
  private sampler: NodeJS.Timeout | null = null;
  private reading: ProbeReader | null = null;
  private disposed = false;
  private consecutiveErrors = 0;
  private lastSampleAtMs: number | null = null;
  private samplingStartedAtMs = 0;
  private connection: MonitoringConnection = 'disconnected';
  private probeView: ProbeView | null = null;
  private lastError: ColabDeckError | null = null;
  private operation: StartOperation | null = null;
  private pendingStop: Promise<void> | null = null;

  private readonly sampleEmitter = new vscode.EventEmitter<{
    readonly server: ServerDescriptor;
    readonly sample: TelemetrySample;
  }>();
  private readonly batchEmitter = new vscode.EventEmitter<{
    readonly server: ServerDescriptor;
    readonly samples: readonly TelemetrySample[];
  }>();
  private readonly statusEmitter = new vscode.EventEmitter<MonitoringStatus>();
  private readonly connectedEmitter = new vscode.EventEmitter<ServerDescriptor>();
  private readonly resetEmitter = new vscode.EventEmitter<string>();
  private readonly lostEmitter = new vscode.EventEmitter<{ readonly serverId: string; readonly reason: string }>();
  private readonly disconnectedEmitter = new vscode.EventEmitter<{ readonly serverId: string; readonly reason: string }>();
  private readonly errorEmitter = new vscode.EventEmitter<{ readonly error: ColabDeckError; readonly serverId: string }>();

  readonly onSample = this.sampleEmitter.event;
  readonly onBatch = this.batchEmitter.event;
  readonly onStatus = this.statusEmitter.event;
  readonly onServerConnected = this.connectedEmitter.event;
  readonly onReset = this.resetEmitter.event;
  readonly onProbeLost = this.lostEmitter.event;
  readonly onServerDisconnected = this.disconnectedEmitter.event;
  readonly onError = this.errorEmitter.event;

  constructor(
    private readonly logger: Logger,
    private readonly registry: ServerRegistry,
    private readonly installer: ProbeInstaller,
    private readonly launcher: TerminalProbeLauncher,
    private readonly commandClient: ProbeCommandClient,
    private readonly store: TelemetryStore,
    private readonly configProvider: () => ColabDeckConfig,
  ) {}

  get status(): MonitoringStatus {
    return {
      serverId: this.current?.id ?? null,
      connection: this.connection,
      probe: this.probeView,
      lastSampleAtMs: this.lastSampleAtMs,
      error: this.lastError,
    };
  }

  start(server = this.registry.selected()): Promise<void> {
    return this.beginStart(server, false);
  }

  restart(): Promise<void> {
    return this.beginStart(this.registry.selected(), true);
  }

  private beginStart(server: ServerDescriptor | undefined, restart: boolean): Promise<void> {
    if (this.disposed || !server || server.id !== this.registry.selected()?.id) {
      return Promise.resolve();
    }
    const previousOperation = this.operation;
    if (previousOperation?.serverId === server.id && !previousOperation.controller.signal.aborted) {
      return previousOperation.promise;
    }
    if (!restart && this.current?.id === server.id && (this.connection === 'connected' || this.connection === 'syncing')) {
      return Promise.resolve();
    }
    const previous = this.current;
    const previousPaths = previous?.id === server.id ? this.paths : null;
    const pendingStop = this.pendingStop;
    previousOperation?.controller.abort();
    this.resetSampling();
    this.current = server;
    this.paths = null;
    this.running = null;
    this.lastError = null;
    this.connection = 'syncing';
    this.probeView = null;
    this.store.clear(server.id);
    const controller = new AbortController();
    const config = this.configProvider();
    const promise = Promise.resolve().then(async () => {
      try {
        await previousOperation?.promise;
        await pendingStop;
        controller.signal.throwIfAborted();
        if (this.registry.selected()?.id !== server.id) {
          this.stop(false);
          return;
        }
        await this.startInternal(server, config, restart, previousPaths, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed && this.current?.id === server.id) {
          const failure = this.asColabDeckError(error, 'PROBE_LAUNCH_FAILED');
          this.logger.error(`[Monitoring] could not start monitoring for ${server.label}`, error);
          this.fail(server, failure);
        }
      } finally {
        if (this.operation?.controller === controller) {
          this.operation = null;
        }
      }
    });
    this.operation = { serverId: server.id, controller, promise };
    if (previous && previous.id !== server.id) {
      this.fireServerDisconnected(previous.id, 'selected server changed');
    } else if (previous) {
      this.fireProbeLost(previous.id, 'monitoring is starting again');
    }
    this.fireStatus();
    this.resetEmitter.fire(server.id);
    return promise;
  }

  private async startInternal(
    server: ServerDescriptor,
    config: ColabDeckConfig,
    restart: boolean,
    previousPaths: ProbePaths | null,
    signal: AbortSignal,
  ): Promise<void> {
    const paths = buildProbePaths(server.id, config.probeDir);
    this.paths = paths;
    let status = await this.launcher.findRunningProbe(paths, signal);
    signal.throwIfAborted();
    if (restart || !status) {
      this.launcher.requireTerminal(server);
      const intervalMs = Math.round(config.sampleIntervalMs);
      await this.installer.install(server, paths, signal);
      signal.throwIfAborted();
      if (restart) {
        if (previousPaths && previousPaths.dir !== paths.dir) {
          const old = await this.launcher.findRunningProbe(previousPaths, signal);
          signal.throwIfAborted();
          if (old) await this.stopProbe(previousPaths, old, signal);
        }
        signal.throwIfAborted();
        if (status) await this.stopProbe(paths, status, signal);
      }
      signal.throwIfAborted();
      status = await this.launcher.launch(server, paths, intervalMs, signal);
    }
    signal.throwIfAborted();
    this.running = status;
    this.store.setInterval(status.sampleIntervalMs);
    const reader = new ProbeReader(paths, this.logger);
    this.reader = reader;
    this.samplingStartedAtMs = Date.now();
    this.sampler = setInterval(() => void this.tick(reader, server), status.sampleIntervalMs);
    await this.tick(reader, server);
  }

  stop(sendStop = true): void {
    this.operation?.controller.abort();
    const server = this.current;
    const paths = this.paths;
    const running = this.running;
    this.resetSampling();
    this.current = null;
    this.paths = null;
    this.running = null;
    this.connection = 'disconnected';
    this.probeView = null;
    this.lastError = null;
    if (server) this.store.clear(server.id);
    if (sendStop && paths && running) {
      const stop = this.stopProbe(paths, running).catch((error) => {
        this.logger.warn('[Monitoring] unable to stop the remote probe', error);
      }).finally(() => {
        if (this.pendingStop === stop) this.pendingStop = null;
      });
      this.pendingStop = stop;
    }
    this.fireStatus();
    if (server) {
      this.fireServerDisconnected(server.id, sendStop ? 'monitoring stopped by user' : 'selected server changed');
    }
  }

  getProbeView(): ProbeView | null {
    return this.probeView;
  }

  getConnection(): MonitoringConnection {
    return this.connection;
  }

  getLatestSample(): TelemetrySample | null {
    return this.current ? this.store.getLatest(this.current.id) : null;
  }

  getSamples(rangeMs: number): readonly TelemetrySample[] {
    return this.current ? this.store.getWindow(this.current.id, rangeMs, Date.now()) : [];
  }

  getServer(): ServerDescriptor | null {
    return this.current;
  }

  getPaths(): ProbePaths | null {
    return this.paths;
  }

  async openProbeLog(): Promise<void> {
    if (this.paths) {
      try {
        const document = await vscode.workspace.openTextDocument(this.paths.log);
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      } catch (error) {
        this.logger.debug('[Monitoring] failed to open probe.log through colab://', error);
      }
    }
    this.logger.show();
  }

  dispose(): void {
    this.disposed = true;
    this.operation?.controller.abort();
    this.resetSampling();
    this.sampleEmitter.dispose();
    this.batchEmitter.dispose();
    this.statusEmitter.dispose();
    this.connectedEmitter.dispose();
    this.resetEmitter.dispose();
    this.lostEmitter.dispose();
    this.disconnectedEmitter.dispose();
    this.errorEmitter.dispose();
  }

  private resetSampling(): void {
    if (this.sampler) {
      clearInterval(this.sampler);
      this.sampler = null;
    }
    this.reader = null;
    this.consecutiveErrors = 0;
    this.lastSampleAtMs = null;
    this.samplingStartedAtMs = 0;
  }

  private async tick(reader: ProbeReader, server: ServerDescriptor): Promise<void> {
    const isCurrent = (): boolean =>
      !this.disposed && this.reader === reader && this.registry.selected()?.id === server.id;
    if (!isCurrent() || this.reading === reader) return;
    this.reading = reader;
    try {
      const result = await reader.read();
      if (!isCurrent()) return;
      this.consecutiveErrors = 0;
      if (result.status.state === 'stopping') {
        this.running = null;
        this.fail(server, new ColabDeckError('The monitoring probe has stopped.', {
          code: 'PROBE_STALE', action: 'RETRY',
        }), 'stale');
        return;
      }
      if (result.reset) {
        this.store.clear(server.id);
      }
      const now = Date.now();
      this.running = result.status;
      const staleMs = Math.max(this.configProvider().idleGuard.staleSampleMs, 2 * result.status.sampleIntervalMs);
      const telemetry = result.samples.map((sample) => toTelemetrySample(sample, now));
      for (const sample of telemetry) this.store.append(server.id, sample);
      const latest = telemetry[telemetry.length - 1];
      if (latest && now - latest.timestampMs <= staleMs && result.status.state === 'running') {
        this.lastSampleAtMs = now;
      }
      if (now - (this.lastSampleAtMs ?? this.samplingStartedAtMs) > staleMs) {
        this.fail(server, new ColabDeckError('Monitoring stopped receiving fresh samples.', {
          code: 'PROBE_STALE', action: 'RETRY',
        }), 'stale');
        return;
      }
      if (this.lastSampleAtMs === now && this.connection !== 'connected') {
        this.connection = 'connected';
        this.connectedEmitter.fire(server);
      }
      this.probeView = {
        pid: result.status.pid,
        bootId: result.status.bootId,
        startedAtMs: result.status.startedAtMs,
        lastSampleAtMs: result.status.lastSampleAtMs,
        lastReceivedAtMs: now,
        sampleIntervalMs: result.status.sampleIntervalMs,
        status: this.connection === 'connected' ? 'running' : 'starting',
      };
      this.fireStatus();
      if (result.reset || telemetry.length > 1) this.resetEmitter.fire(server.id);
      if (latest && this.lastSampleAtMs === now) {
        this.sampleEmitter.fire({ server, sample: latest });
        this.batchEmitter.fire({ server, samples: telemetry });
      }
    } catch (error) {
      if (!isCurrent()) return;
      const failure = this.asColabDeckError(error, 'PROBE_STALE');
      const staleMs = Math.max(this.configProvider().idleGuard.staleSampleMs, 2 * (this.running?.sampleIntervalMs ?? 0));
      if (++this.consecutiveErrors >= 3 || Date.now() - (this.lastSampleAtMs ?? this.samplingStartedAtMs) > staleMs) {
        this.fail(server, failure, failure.code === 'PROBE_PROTOCOL_MISMATCH' ? 'error' : 'stale');
      } else {
        this.logger.debug(`[Monitoring] transient read error for ${server.label}`, error);
      }
    } finally {
      if (this.reading === reader) this.reading = null;
    }
  }

  private fail(server: ServerDescriptor, error: ColabDeckError, connection: 'error' | 'stale' = 'error'): void {
    this.resetSampling();
    this.store.clear(server.id);
    this.connection = connection;
    this.probeView = this.probeView ? { ...this.probeView, status: connection } : null;
    this.lastError = error;
    this.fireProbeLost(server.id, error.message);
    this.errorEmitter.fire({ error, serverId: server.id });
    this.fireStatus();
    this.resetEmitter.fire(server.id);
  }

  private async stopProbe(paths: ProbePaths, status: ProbeStatus, signal?: AbortSignal): Promise<void> {
    const reader = new ProbeReader(paths, this.logger);
    const current = await reader.readStatus();
    signal?.throwIfAborted();
    if (current.bootId !== status.bootId || current.state === 'stopping' || current.probeDir !== paths.dir) return;
    const stopped = await this.commandClient.stop(paths.serverId, paths.relativeDir);
    if (stopped) {
      const deadline = Date.now() + 10_000;
      do {
        await delay(500);
        const updated = await reader.readStatus();
        if (updated.state === 'stopping' || updated.bootId !== status.bootId) return;
      } while (Date.now() < deadline);
    }
    throw new ColabDeckError('The previous monitoring probe did not stop.', {
      code: 'PROBE_STALE', action: 'RETRY',
    });
  }

  private fireStatus(): void {
    this.statusEmitter.fire(this.status);
  }

  private fireProbeLost(serverId: string, reason: string): void {
    this.lostEmitter.fire({ serverId, reason });
  }

  private fireServerDisconnected(serverId: string, reason: string): void {
    this.disconnectedEmitter.fire({ serverId, reason });
  }

  private asColabDeckError(error: unknown, fallbackCode: ColabDeckError['code']): ColabDeckError {
    if (error instanceof ColabDeckError) {
      return error;
    }
    return new ColabDeckError(error instanceof Error ? error.message : String(error), {
      code: fallbackCode,
      recoverable: true,
      action: 'RETRY',
      cause: error,
    });
  }
}
