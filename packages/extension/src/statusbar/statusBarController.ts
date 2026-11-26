import * as vscode from 'vscode';
import { formatBytesShort, formatDuration } from '@colabdeck/shared';
import type { IdleGuardView, TelemetrySample } from '@colabdeck/shared';
import type { IdleGuardService } from '../idleGuard/idleGuardService.js';
import type { Logger } from '../log.js';
import type { ServerRegistry } from '../server/serverRegistry.js';
import type { MonitoringService } from '../telemetry/monitoringService.js';
import type { TelemetryStore } from '../telemetry/store.js';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly registry: ServerRegistry,
    private readonly store: TelemetryStore,
    private readonly idleGuard: IdleGuardService,
    private readonly monitoring: MonitoringService,
  ) {
    this.item = vscode.window.createStatusBarItem(
      'colabdeck.statusBar',
      vscode.StatusBarAlignment.Right,
      10,
    );
    this.item.command = 'colabdeck.openDashboard';
    this.item.show();
    this.disposables.push(
      registry.onDidChangeSelection(() => this.update()),
      registry.onDidChangeServers(() => this.update()),
      monitoring.onStatus(() => this.update()),
      idleGuard.onChange(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const server = this.registry.selected();
    const sample = server ? this.store.getLatest(server.id) : null;
    const idle = this.idleGuard.snapshot;
    const connection = this.monitoring.getConnection();
    const text = this.buildText(server?.label ?? null, sample, idle.state, connection);
    this.item.text = text;
    this.item.tooltip = this.buildTooltip(server?.label ?? null, server?.id ?? null, sample, idle.state, connection);
    this.item.backgroundColor = this.backgroundColorFor(idle.state.status, connection);
  }

  private backgroundColorFor(
    status: IdleGuardView['status'],
    connection: string,
  ): vscode.StatusBarItem['backgroundColor'] {
    if (status === 'ERROR') {
      return new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (
      status === 'COUNTDOWN_WARNING' ||
      status === 'TERMINATING' ||
      connection === 'stale' ||
      connection === 'error'
    ) {
      return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.item.dispose();
  }

  private buildText(
    serverLabel: string | null,
    sample: TelemetrySample | null,
    idle: IdleGuardView,
    connection: string,
  ): string {
    if (!serverLabel) {
      return '$(plug) ColabDeck: No server';
    }
    if (connection === 'disconnected') {
      return '$(plug) ColabDeck: Disconnected';
    }
    if (connection === 'error') {
      return '$(error) ColabDeck: Error';
    }
    if (connection === 'syncing' && !sample) {
      return '$(sync~spin) ColabDeck: Starting';
    }
    const aggregate = sample?.gpuAggregate ?? null;
    const shortName = aggregate?.shortName ?? 'No GPU';
    const used = aggregate?.memoryUsedBytes ?? null;
    const total = aggregate?.memoryTotalBytes ?? null;
    const vram = used !== null && total !== null ? `${formatBytesShort(used)}/${formatBytesShort(total)}` : '—';
    const stale = connection === 'stale' ? ' | OUT OF DATE' : '';
    return `${shortName} | VRAM ${vram} | Idle: ${this.idleLabel(idle)}${stale}`;
  }

  private idleLabel(idle: IdleGuardView): string {
    switch (idle.status) {
      case 'DISABLED':
        return 'OFF';
      case 'DISCONNECTED':
        return '—';
      case 'SYNCING':
        return 'STARTING';
      case 'ACTIVE':
        return 'ON';
      case 'IDLE_DETECTED':
        return `IDLE ${formatDuration(idle.idleForMs)}`;
      case 'COUNTDOWN_WARNING': {
        const countdown = this.idleGuard.snapshot.countdown;
        if (!countdown || countdown.phase === 'expired' || countdown.phase === 'kernel-busy') {
          return 'RELEASE?';
        }
        return `RELEASE ${formatDuration(countdown.remainingMs)}`;
      }
      case 'TERMINATING':
        return 'STOPPING';
      case 'TERMINATED':
        return 'RELEASED';
      case 'ERROR':
        return 'ERROR';
      case 'UNSUPPORTED':
        return 'N/A';
    }
  }

  private buildTooltip(
    serverLabel: string | null,
    serverId: string | null,
    sample: TelemetrySample | null,
    idle: IdleGuardView,
    connection: string,
  ): vscode.MarkdownString {
    const connectionLabel: Readonly<Record<string, string>> = {
      connected: 'Connected',
      syncing: 'Starting',
      stale: 'Out of date',
      disconnected: 'Disconnected',
      error: 'Error',
    };
    const lines = [
      '**ColabDeck**',
      '',
      `- Server: ${serverLabel ?? 'none'}`,
      `- Connection: ${connectionLabel[connection] ?? 'Unknown'}`,
      `- Idle Guard: ${this.idleLabel(idle)}`,
    ];
    if (sample) {
      lines.push(
        `- GPU: ${sample.gpuAggregate?.shortName ?? 'none'}`,
        `- VRAM: ${formatBytesShort(sample.gpuAggregate?.memoryUsedBytes ?? null)} / ${formatBytesShort(sample.gpuAggregate?.memoryTotalBytes ?? null)}`,
        `- RAM: ${formatBytesShort(sample.ram.usedBytes)} / ${formatBytesShort(sample.ram.totalBytes)}`,
        `- Disk free: ${formatBytesShort(sample.disk.freeBytes)}`,
      );
    }
    lines.push('', 'Click to open the ColabDeck dashboard.');
    const markdown = new vscode.MarkdownString(lines.join('\n'));
    markdown.isTrusted = false;
    return markdown;
  }
}
