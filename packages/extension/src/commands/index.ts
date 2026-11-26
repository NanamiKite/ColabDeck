import * as vscode from 'vscode';
import { ColabDeckError, formatBytes } from '@colabdeck/shared';
import type { Logger } from '../log.js';
import type { ErrorCenter } from '../errors/errorCenter.js';
import type { IdleGuardService } from '../idleGuard/idleGuardService.js';
import type { ServerRegistry } from '../server/serverRegistry.js';
import type { MonitoringService } from '../telemetry/monitoringService.js';
import type { ToolboxService } from '../toolbox/toolboxService.js';
import type { DashboardProvider } from '../webview/dashboardProvider.js';

export interface CommandServices {
  readonly logger: Logger;
  readonly registry: ServerRegistry;
  readonly monitoring: MonitoringService;
  readonly idleGuard: IdleGuardService;
  readonly toolbox: ToolboxService;
  readonly errors: ErrorCenter;
  readonly dashboard: DashboardProvider;
  readonly snoozeMs: () => number;
}

export function registerCommands(services: CommandServices): vscode.Disposable[] {
  const register = (command: string, callback: (...args: readonly never[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(command, callback);

  return [
    register('colabdeck.openDashboard', () => vscode.commands.executeCommand('colabdeck.dashboard.focus')),
    register('colabdeck.refresh', async () => {
      await services.registry.refresh();
      await services.monitoring.start(services.registry.selected());
      services.dashboard.sendSnapshot();
    }),
    register('colabdeck.stopMonitoring', () => {
      const server = services.registry.selected();
      services.monitoring.stop();
      if (server) {
        services.idleGuard.handleServerDisconnected(server.id, 'monitoring stopped by user');
      }
      services.dashboard.sendSnapshot();
    }),
    register('colabdeck.startMonitoring', async () => {
      const server = services.registry.selected();
      if (!server) {
        await vscode.commands.executeCommand('colabdeck.openDashboard');
        return;
      }
      await services.monitoring.start(server);
      services.dashboard.sendSnapshot();
    }),
    register('colabdeck.restartProbe', async () => {
      await services.monitoring.restart();
      services.dashboard.sendSnapshot();
    }),
    register('colabdeck.openProbeLog', () => services.monitoring.openProbeLog()),
    register('colabdeck.showServerInfo', () => showServerInfo(services)),
    register('colabdeck.idleGuard.cancel', () => services.idleGuard.cancel('command')),
    register('colabdeck.idleGuard.snooze', () => services.idleGuard.snooze(services.snoozeMs(), 'command')),
    register('colabdeck.idleGuard.releaseNow', () => services.idleGuard.releaseNow('command')),
    register('colabdeck.toolkit.killProcess', () => killProcessCommand(services)),
    register('colabdeck.toolkit.clearCudaCache', () => clearCudaCacheCommand(services)),
    register('colabdeck.toolkit.scanDisk', () => scanDiskCommand(services)),
  ];
}

function showServerInfo(services: CommandServices): void {
  const server = services.registry.selected();
  const lines = [
    `servers=${services.registry.all.length}`,
    ...services.registry.all.map(
      (item) =>
        `- ${item.label} | id=${item.id} | source=${item.source} | kernelApi=${String(item.kernelApiAvailable)}`,
    ),
    `selected=${server?.id ?? 'none'}`,
    `connection=${services.monitoring.getConnection()}`,
    `probe=${JSON.stringify(services.monitoring.getProbeView())}`,
  ];
  services.logger.info(`[ServerInfo]\n${lines.join('\n')}`);
  services.logger.show();
}

async function killProcessCommand(services: CommandServices): Promise<void> {
  try {
    const list = await services.toolbox.listGpuProcesses();
    if (list.processes.length === 0) {
      void vscode.window.showInformationMessage('No GPU processes found.');
      return;
    }
    const items = list.processes.map((process) => ({
      label: `${process.pid} — ${process.name}`,
      description: formatBytes(process.usedMemoryBytes),
      ...(process.command !== null ? { detail: process.command } : {}),
      pid: process.pid,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'ColabDeck: Kill GPU Process',
      placeHolder: 'Select a GPU process to stop.',
    });
    if (!picked) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Stop GPU process ${picked.pid}?`,
      { modal: true },
      'Kill',
    );
    if (confirmation !== 'Kill') {
      return;
    }
    const result = await services.toolbox.killProcess(picked.pid);
    if (result.kind === 'KILL_PROCESS') {
      void vscode.window.showInformationMessage(result.message ?? `Process ${picked.pid} handled.`);
    }
  } catch (error) {
    reportError(services, error);
  }
}

async function clearCudaCacheCommand(services: CommandServices): Promise<void> {
  try {
    const result = await services.toolbox.clearCudaCache();
    if (result.kind === 'CLEAR_CUDA_CACHE') {
      void vscode.window.showInformationMessage(result.message);
    }
  } catch (error) {
    reportError(services, error);
  }
}

async function scanDiskCommand(services: CommandServices): Promise<void> {
  try {
    const path = await vscode.window.showInputBox({
      title: 'ColabDeck: Scan Disk',
      prompt: 'Absolute path under /content or /tmp',
      value: '/content',
      ignoreFocusOut: true,
    });
    if (!path) {
      return;
    }
    const entriesRaw = await vscode.window.showInputBox({
      title: 'ColabDeck: Scan Disk',
      prompt: 'Maximum entries',
      value: '50',
    });
    const maxEntries = Number(entriesRaw ?? 50);
    const result = await services.toolbox.scanDisk(path, Number.isFinite(maxEntries) ? maxEntries : 50, 4);
    if (result.kind !== 'SCAN_DISK') {
      return;
    }
    const items = result.entries.map((entry) => ({
      label: `${formatBytes(entry.bytes)}  ${entry.path}`,
      description: entry.kind,
      detail: entry.path,
    }));
    await vscode.window.showQuickPick(items, {
      title: `ColabDeck: largest files under ${path}${result.truncated ? ' (truncated)' : ''}`,
      matchOnDetail: true,
    });
  } catch (error) {
    reportError(services, error);
  }
}

function reportError(services: CommandServices, error: unknown): void {
  const colabDeckError =
    error instanceof ColabDeckError
      ? error
      : new ColabDeckError(error instanceof Error ? error.message : String(error), {
          code: 'UNKNOWN',
          recoverable: true,
          action: 'RETRY',
          cause: error,
        });
  services.errors.push(colabDeckError, services.registry.currentId);
  services.logger.error(colabDeckError);
  void vscode.window.showErrorMessage(colabDeckError.message);
}
