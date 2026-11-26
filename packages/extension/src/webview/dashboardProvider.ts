import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ColabDeckError, timeRangeToMs, WEBVIEW_PROTOCOL_VERSION } from '@colabdeck/shared';
import type {
  ColabDeckErrorAction,
  DashboardSnapshot,
  HostToWebviewMessage,
  ServerView,
  TimeRange,
  ToolboxResult,
  WebviewToHostMessage,
} from '@colabdeck/shared';
import { webviewToHostMessageSchema } from '@colabdeck/shared';
import type { ColabDeckConfig } from '../config.js';
import { toDashboardSettings } from '../config.js';
import type { ErrorCenter } from '../errors/errorCenter.js';
import type { IdleGuardService } from '../idleGuard/idleGuardService.js';
import type { Logger } from '../log.js';
import type { ServerRegistry } from '../server/serverRegistry.js';
import type { MonitoringService } from '../telemetry/monitoringService.js';
import type { TelemetryStore } from '../telemetry/store.js';
import type { ToolboxService } from '../toolbox/toolboxService.js';
import { activateColabExtension } from '../colabExtension.js';
import { buildDashboardHtml } from './html.js';

export class DashboardProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private range: TimeRange;
  private lastStatusKey = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly registry: ServerRegistry,
    private readonly store: TelemetryStore,
    private readonly monitoring: MonitoringService,
    private readonly idleGuard: IdleGuardService,
    private readonly errors: ErrorCenter,
    private readonly toolbox: ToolboxService,
    private readonly configProvider: () => ColabDeckConfig,
  ) {
    this.range = configProvider().timeRange;
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };
    const indexHtml = await fs.readFile(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.html').fsPath,
      'utf8',
    );
    const nonce = randomBytes(16).toString('hex');
    const assetBaseUri = webviewView.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'))
      .toString();
    webviewView.webview.html = buildDashboardHtml({
      indexHtml,
      assetBaseUri,
      cspSource: webviewView.webview.cspSource,
      nonce,
    });
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message)),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.sendSnapshot();
        }
      }),
      this.monitoring.onStatus(() => this.handleMonitoringStatus()),
      this.monitoring.onReset(() => this.sendSnapshot()),
      this.monitoring.onSample(({ sample }) => {
        if (webviewView.visible) {
          this.post({ type: 'TELEMETRY_APPEND', sample });
        }
      }),
      this.idleGuard.onChange((snapshot) => {
        this.post({
          type: 'IDLE_GUARD_STATE',
          state: snapshot.state,
          countdown: snapshot.countdown,
          recentTransitions: snapshot.recentTransitions,
        });
      }),
      this.idleGuard.onError((error) => this.pushError(error)),
      this.registry.onDidChangeServers(() => this.sendSnapshotIfVisible()),
      this.registry.onDidChangeSelection(() => this.sendSnapshotIfVisible()),
      this.errors.onDidChange(() => this.sendSnapshotIfVisible()),
    );
  }

  sendSnapshot(): void {
    const snapshot = this.buildSnapshot();
    this.post({ type: 'SNAPSHOT', snapshot });
    this.sendTelemetryBatch(this.range);
    const idle = this.idleGuard.snapshot;
    this.post({
      type: 'IDLE_GUARD_STATE',
      state: idle.state,
      countdown: idle.countdown,
      recentTransitions: idle.recentTransitions,
    });
  }

  private buildSnapshot(): DashboardSnapshot {
    const server = this.registry.selected();
    const monitoringMatches = server !== undefined && this.monitoring.getServer()?.id === server.id;
    const connection = server ? (monitoringMatches ? this.monitoring.getConnection() : 'syncing') : 'disconnected';
    const idle = this.idleGuard.snapshot;
    return {
      protocol: 1,
      generatedAtMs: Date.now(),
      servers: this.registry.all.map((item): ServerView => ({
        id: item.id,
        label: item.label,
        source: item.source,
        notebookUri: item.notebookUri,
      })),
      selectedServerId: server?.id ?? null,
      connection,
      probe: server && monitoringMatches ? this.monitoring.getProbeView() : null,
      latest: server
        ? (this.store.getLatest(server.id) ?? (monitoringMatches ? this.monitoring.getLatestSample() : null))
        : null,
      idleGuard: idle.state,
      countdown: idle.countdown,
      errors: this.errors.list(),
      settings: toDashboardSettings(this.configProvider()),
    };
  }

  private sendSnapshotIfVisible(): void {
    if (this.view?.visible) {
      this.sendSnapshot();
    }
  }

  private handleMonitoringStatus(): void {
    const status = this.monitoring.status;
    const key = `${status.serverId ?? ''}|${status.connection}|${status.probe?.bootId ?? ''}|${status.probe?.status ?? ''}|${status.error?.code ?? ''}`;
    if (key === this.lastStatusKey) {
      return;
    }
    this.lastStatusKey = key;
    this.sendSnapshotIfVisible();
  }

  private sendTelemetryBatch(range: TimeRange): void {
    if (!this.view?.visible) {
      return;
    }
    this.post({
      type: 'TELEMETRY_BATCH',
      range,
      samples: this.monitoring.getSamples(timeRangeToMs(range)),
    });
  }

  private post(message: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const parsed = webviewToHostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`[Dashboard] rejected invalid webview message: ${parsed.error.message}`);
      return;
    }
    const message: WebviewToHostMessage = parsed.data;
    try {
      switch (message.type) {
        case 'READY':
          if (message.protocol !== WEBVIEW_PROTOCOL_VERSION) {
            this.post({
              type: 'PROTOCOL_MISMATCH',
              hostProtocol: WEBVIEW_PROTOCOL_VERSION,
              webviewProtocol: message.protocol,
            });
            return;
          }
          this.sendSnapshot();
          return;
        case 'REQUEST_SNAPSHOT':
          this.range = message.range;
          this.sendTelemetryBatch(message.range);
          return;
        case 'SELECT_SERVER':
          this.registry.select(message.serverId);
          await this.monitoring.start(this.registry.selected());
          this.sendSnapshot();
          return;
        case 'IDLE_GUARD_CANCEL':
          this.idleGuard.cancel('webview');
          return;
        case 'IDLE_GUARD_SNOOZE':
          this.idleGuard.snooze(message.durationMs, 'webview');
          return;
        case 'IDLE_GUARD_RELEASE_NOW':
          this.idleGuard.releaseNow('webview');
          return;
        case 'IDLE_GUARD_SET_ENABLED':
          await this.setIdleGuardEnabled(message.enabled);
          return;
        case 'REFRESH_GPU_PROCESSES':
          await this.refreshProcesses();
          return;
        case 'KILL_PROCESS':
          await this.killProcess(message.requestId, message.pid);
          return;
        case 'CLEAR_CUDA_CACHE':
          await this.clearCudaCache(message.requestId);
          return;
        case 'SCAN_DISK':
          await this.scanDisk(message.requestId, message.path, message.maxEntries, message.maxDepth);
          return;
        case 'DISMISS_ERROR':
          this.errors.dismiss(message.errorId);
          return;
        case 'MOUNT_COLAB_SERVER':
          if (!(await activateColabExtension(this.logger))) {
            throw new ColabDeckError('The official Google Colab extension is unavailable.', {
              code: 'SERVER_UNAVAILABLE',
              detail: 'Install and sign in to the official Colab extension, then retry.',
              recoverable: true,
              action: 'OPEN_SETTINGS',
            });
          }
          await vscode.commands.executeCommand('colab.mountServer');
          await this.registry.refresh({ discoverKernelApi: this.configProvider().launchMethod === 'kernel' });
          await this.monitoring.start(this.registry.selected());
          this.sendSnapshot();
          return;
        case 'RELOAD_WINDOW':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        case 'OPEN_SETTINGS':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'colabdeck');
          return;
        case 'OPEN_PROBE_LOG':
          await this.monitoring.openProbeLog();
          return;
        case 'RETRY_PROBE':
          await this.registry.refresh({ discoverKernelApi: this.configProvider().launchMethod === 'kernel' });
          await this.monitoring.restart();
          this.sendSnapshot();
          return;
      }
    } catch (error) {
      this.pushError(
        error instanceof ColabDeckError
          ? error
          : new ColabDeckError(error instanceof Error ? error.message : String(error), {
              code: 'UNKNOWN',
              recoverable: true,
              action: 'RETRY',
              cause: error,
            }),
      );
    }
  }

  private async refreshProcesses(): Promise<void> {
    try {
      const result = await this.toolbox.listGpuProcesses();
      this.post({
        type: 'GPU_PROCESSES',
        processes: result.processes,
        source: result.source,
        fetchedAtMs: Date.now(),
        warning: result.warning,
      });
    } catch (error) {
      this.pushError(this.toColabDeckError(error, 'NONE'));
    }
  }

  private async killProcess(requestId: string, pid: number): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      `Stop GPU process ${pid}?`,
      { modal: true },
      'Kill',
    );
    if (confirmation !== 'Kill') {
      return;
    }
    try {
      const result = await this.toolbox.killProcess(pid);
      this.post({ type: 'TOOLBOX_RESULT', requestId, result });
      await this.refreshProcesses();
    } catch (error) {
      this.pushError(this.toColabDeckError(error, 'NONE'));
    }
  }

  private async scanDisk(requestId: string, path: string, maxEntries: number, maxDepth: number): Promise<void> {
    try {
      const result = await this.toolbox.scanDisk(path, maxEntries, maxDepth);
      this.post({ type: 'TOOLBOX_RESULT', requestId, result });
    } catch (error) {
      this.pushError(this.toColabDeckError(error, 'NONE'));
    }
  }

  private async clearCudaCache(requestId: string): Promise<void> {
    try {
      const result: ToolboxResult = await this.toolbox.clearCudaCache();
      this.post({ type: 'TOOLBOX_RESULT', requestId, result });
    } catch (error) {
      this.pushError(this.toColabDeckError(error, 'NONE'));
    }
  }

  private async setIdleGuardEnabled(enabled: boolean): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('colabdeck.idleGuard');
    try {
      await configuration.update('enabled', enabled, vscode.ConfigurationTarget.Workspace);
    } catch {
      await configuration.update('enabled', enabled, vscode.ConfigurationTarget.Global);
    }
  }

  private pushError(error: ColabDeckError): void {
    const uiError = this.errors.push(error, this.registry.currentId);
    if (!uiError) {
      return;
    }
    this.post({
      type: 'ERROR',
      errorId: uiError.id,
      message: uiError.message,
      detail: uiError.detail,
      recoverable: uiError.recoverable,
      action: uiError.action,
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = null;
  }

  private toColabDeckError(error: unknown, action: ColabDeckErrorAction = 'RETRY'): ColabDeckError {
    if (error instanceof ColabDeckError) {
      return error;
    }
    return new ColabDeckError(error instanceof Error ? error.message : String(error), {
      code: 'UNKNOWN',
      recoverable: true,
      action,
      cause: error,
    });
  }
}
