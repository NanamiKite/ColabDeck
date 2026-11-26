import * as vscode from 'vscode';
import { ColabDeckError, toTelemetrySample } from '@colabdeck/shared';
import type { ProbeView, ServerDescriptor, TelemetrySample } from '@colabdeck/shared';
import { readConfig, type ColabDeckConfig } from '../config.js';
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

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export class MonitoringService implements vscode.Disposable {
  private current: ServerDescriptor | null = null;
  private paths: ProbePaths | null = null;
  private reader: ProbeReader | null = null;
  private sampler: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private disposed = false;
  private restartAttempts = 0;
  private lastRestartAt = 0;
  private consecutiveErrors = 0;
  private lastSeqAdvanceAt = 0;
  private connection: MonitoringConnection = 'disconnected';
  private probeView: ProbeView | null = null;
  private lastError: ColabDeckError | null = null;
  private startPromise: Promise<void> | null = null;

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
      lastSampleAtMs: this.lastSeqAdvanceAt || null,
      error: this.lastError,
    };
  }

  async start(server = this.registry.selected()): Promise<void> {
    while (this.startPromise) {
      await this.startPromise;
    }
    if (this.current?.id === server?.id && this.connection !== 'disconnected' && this.connection !== 'error') {
      return;
    }
    this.startPromise = this.startInternal(server);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(server: ServerDescriptor | undefined): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!server) {
      this.stopInternal(true);
      this.connection = 'disconnected';
      this.probeView = null;
      this.fireStatus();
      return;
    }
    if (this.current?.id === server.id && this.connection !== 'disconnected' && this.connection !== 'error') {
      return;
    }
    const previous = this.current;
    const previousPaths = this.paths;
    this.stopInternal(false);
    if (previous && previous.id !== server.id) {
      this.fireServerDisconnected(previous.id, 'selected server changed');
      if (previousPaths) {
        void this.commandClient.stop(previous.id, previousPaths.relativeDir);
      }
    }
    if (previous && previous.id === server.id && previousPaths) {
      const stopped = await this.commandClient.stop(previous.id, previousPaths.relativeDir, 2_000);
      if (!stopped) {
        await this.launcher.killProbe(previous, previousPaths);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.current = server;
    this.restartAttempts = 0;
    this.lastError = null;
    this.connection = 'syncing';
    this.probeView = null;
    this.fireStatus();
    try {
      this.paths = buildProbePaths(server.id, this.configProvider().probeDir);
      await this.installer.install(server, this.paths);
      await this.launcher.launch(server, this.paths, this.configProvider().sampleIntervalMs);
      this.store.clear(server.id);
      this.resetEmitter.fire(server.id);
      this.reader = new ProbeReader(this.paths, this.logger);
      this.startSampler();
      await this.tick();
    } catch (error) {
      this.lastError = this.asColabDeckError(error, 'PROBE_LAUNCH_FAILED');
      this.connection = 'error';
      this.probeView = null;
      this.logger.error(`[Monitoring] failed to start probe for ${server.label}`, error);
      this.fireError(this.lastError);
      this.fireProbeLost(server.id, this.lastError.message);
      this.fireStatus();
    }
  }

  async restart(): Promise<void> {
    while (this.startPromise) {
      await this.startPromise;
    }
    const server = this.current ?? this.registry.selected();
    if (!server) {
      return;
    }
    this.restartAttempts = 0;
    if (this.current?.id === server.id && this.paths) {
      this.fireProbeLost(server.id, 'probe restarted by user');
      await this.restartInternal(server);
      return;
    }
    this.stopInternal(true);
    await this.start(server);
  }

  stop(): void {
    const server = this.current;
    this.stopInternal(true);
    this.connection = 'disconnected';
    this.probeView = null;
    this.lastError = null;
    this.fireStatus();
    if (server) {
      this.fireServerDisconnected(server.id, 'monitoring stopped by user');
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
    this.stopInternal(true);
    this.sampleEmitter.dispose();
    this.batchEmitter.dispose();
    this.statusEmitter.dispose();
    this.connectedEmitter.dispose();
    this.resetEmitter.dispose();
    this.lostEmitter.dispose();
    this.disconnectedEmitter.dispose();
    this.errorEmitter.dispose();
  }

  private startSampler(): void {
    this.stopSampler();
    const interval = this.configProvider().sampleIntervalMs;
    this.sampler = setInterval(() => void this.tick(), interval);
  }

  private stopSampler(): void {
    if (this.sampler) {
      clearInterval(this.sampler);
      this.sampler = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.reader || !this.current || !this.paths) {
      return;
    }
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    const server = this.current;
    try {
      const result = await this.reader.read();
      if (this.current?.id !== server.id) {
        return;
      }
      if (result.reset) {
        this.store.clear(server.id);
        this.resetEmitter.fire(server.id);
      }
      const now = Date.now();
      if (result.samples.length > 0) {
        if (this.connection !== 'connected') {
          this.connection = 'connected';
          this.connectedEmitter.fire(server);
        }
        this.lastSeqAdvanceAt = now;
        this.consecutiveErrors = 0;
        if (now - this.lastRestartAt > 5 * 60_000) {
          this.restartAttempts = 0;
        }
        const telemetrySamples: TelemetrySample[] = [];
        for (const sample of result.samples) {
          const telemetry = toTelemetrySample(sample, now);
          this.store.append(server.id, telemetry);
          this.sampleEmitter.fire({ server, sample: telemetry });
          telemetrySamples.push(telemetry);
        }
        if (telemetrySamples.length > 0) {
          this.batchEmitter.fire({ server, samples: telemetrySamples });
        }
        this.lastError = null;
      }
      if (this.lastSeqAdvanceAt === 0 && result.status.seq > 0) {
        this.lastSeqAdvanceAt = now;
      }
      const stale = this.configProvider().idleGuard.staleSampleMs;
      if (
        result.samples.length === 0 &&
        this.lastSeqAdvanceAt > 0 &&
        now - this.lastSeqAdvanceAt > stale
      ) {
        this.handleStale(server);
        return;
      }
      this.probeView = {
        pid: result.status.pid,
        bootId: result.status.bootId,
        startedAtMs: result.status.startedAtMs,
        lastSampleAtMs: result.status.lastSampleAtMs,
        lastReceivedAtMs: now,
        sampleIntervalMs: result.status.sampleIntervalMs,
        status: this.connection === 'connected' ? 'running' : this.connection === 'stale' ? 'stale' : this.connection === 'error' ? 'error' : 'starting',
      };
      if (this.connection === 'stale') {
        this.connection = 'connected';
        this.connectedEmitter.fire(server);
      }
      this.fireStatus();
    } catch (error) {
      await this.handleReadError(server, error);
    } finally {
      this.ticking = false;
    }
  }

  private handleStale(server: ServerDescriptor): void {
    if (this.connection === 'stale' || this.connection === 'disconnected' || this.connection === 'error') {
      return;
    }
    this.connection = 'stale';
    if (this.probeView) {
      this.probeView = { ...this.probeView, status: 'stale' };
    }
    this.fireProbeLost(server.id, 'probe samples became stale');
    this.fireStatus();
    this.scheduleRestart(server);
  }

  private async handleReadError(server: ServerDescriptor, error: unknown): Promise<void> {
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors < 3) {
      this.logger.debug(`[Monitoring] transient read error for ${server.label}`, error);
      return;
    }
    const colabDeckError = this.asColabDeckError(error, 'PROBE_STALE');
    const alive = await this.registry.validateServer(server.id);
    if (this.current?.id !== server.id) {
      return;
    }
    if (!alive) {
      this.connection = 'disconnected';
      this.probeView = null;
      this.stopSampler();
      this.lastError = colabDeckError;
      this.fireServerDisconnected(server.id, 'Colab server is no longer reachable');
      this.fireStatus();
      return;
    }
    if (colabDeckError.code === 'PROBE_PROTOCOL_MISMATCH') {
      this.connection = 'error';
      this.probeView = null;
      this.lastError = colabDeckError;
      this.stopSampler();
      this.fireError(colabDeckError);
      this.fireProbeLost(server.id, colabDeckError.message);
      this.fireStatus();
      return;
    }
    this.connection = 'stale';
    this.lastError = colabDeckError;
    this.fireProbeLost(server.id, colabDeckError.message);
    this.fireStatus();
    this.scheduleRestart(server);
  }

  private scheduleRestart(server: ServerDescriptor): void {
    this.stopSampler();
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      const error = new ColabDeckError('Monitoring stopped responding.', {
        code: 'PROBE_STALE',
        detail: 'Retry to restart monitoring.',
        recoverable: true,
        action: 'RETRY',
      });
      this.connection = 'error';
      this.lastError = error;
      this.fireError(error);
      this.fireStatus();
      return;
    }
    const delay = RESTART_DELAYS_MS[this.restartAttempts] ?? 30_000;
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartInternal(server);
    }, delay);
    this.logger.warn(
      `[Monitoring] probe stale for ${server.label}; restarting in ${delay / 1000}s (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
    );
  }

  private async restartInternal(server: ServerDescriptor): Promise<void> {
    if (this.disposed || !this.paths || this.current?.id !== server.id) {
      return;
    }
    this.lastRestartAt = Date.now();
    this.stopSampler();
    const stopped = await this.commandClient.stop(server.id, this.paths.relativeDir, 2_000);
    if (!stopped) {
      this.logger.warn(`[Monitoring] probe did not acknowledge STOP; using pkill fallback for ${server.label}`);
      await this.launcher.killProbe(server, this.paths);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.connection = 'syncing';
    this.probeView = null;
    this.fireStatus();
    try {
      await this.installer.install(server, this.paths);
      await this.launcher.launch(server, this.paths, this.configProvider().sampleIntervalMs);
      this.store.clear(server.id);
      this.resetEmitter.fire(server.id);
      this.reader = new ProbeReader(this.paths, this.logger);
      this.startSampler();
      await this.tick();
    } catch (error) {
      this.lastError = this.asColabDeckError(error, 'PROBE_LAUNCH_FAILED');
      this.connection = 'error';
      this.probeView = null;
      this.logger.error(`[Monitoring] failed to restart probe for ${server.label}`, error);
      this.fireError(this.lastError);
      this.fireProbeLost(server.id, this.lastError.message);
      this.fireStatus();
    }
  }

  private stopInternal(sendStop: boolean): void {
    this.stopSampler();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const server = this.current;
    this.reader = null;
    if (sendStop && server && this.paths) {
      void this.commandClient.stop(server.id, this.paths.relativeDir);
    }
    this.current = null;
    this.paths = null;
    this.connection = 'disconnected';
    this.probeView = null;
    this.lastSeqAdvanceAt = 0;
    this.consecutiveErrors = 0;
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

  private fireError(error: ColabDeckError): void {
    this.errorEmitter.fire({ error, serverId: this.current?.id ?? '' });
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
