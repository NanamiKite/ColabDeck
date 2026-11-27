import * as vscode from 'vscode';
import { ColabDeckError } from '@colabdeck/shared';
import { readConfig } from './config.js';
import { registerCommands } from './commands/index.js';
import { ErrorCenter } from './errors/errorCenter.js';
import { IdleGuardService } from './idleGuard/idleGuardService.js';
import { KernelClient } from './jupyter/kernelClient.js';
import { Logger } from './log.js';
import { ProbeCommandClient } from './probe/commandClient.js';
import { ProbeInstaller } from './probe/installer.js';
import { TerminalProbeLauncher } from './probe/launcher.js';
import { ServerRegistry } from './server/serverRegistry.js';
import { StatusBarController } from './statusbar/statusBarController.js';
import { MonitoringService } from './telemetry/monitoringService.js';
import { TelemetryStore } from './telemetry/store.js';
import { ToolboxService } from './toolbox/toolboxService.js';
import { DashboardProvider } from './webview/dashboardProvider.js';

export interface ColabDeckApi {
  readonly activationMs: number;
}

export async function activate(context: vscode.ExtensionContext): Promise<ColabDeckApi> {
  const activationStartedAt = Date.now();
  let config = readConfig();
  const logger = new Logger('ColabDeck', config.logLevel);
  context.subscriptions.push(logger);

  const registry = new ServerRegistry(context, logger);
  const store = new TelemetryStore(config.sampleIntervalMs);
  const installer = new ProbeInstaller(context, logger);
  const launcher = new TerminalProbeLauncher(logger);
  const commandClient = new ProbeCommandClient(logger);
  const kernelClient = new KernelClient(logger);
  const monitoring = new MonitoringService(
    logger,
    registry,
    installer,
    launcher,
    commandClient,
    store,
    () => config,
  );
  const errors = new ErrorCenter();

  const idleGuard = new IdleGuardService(
    logger,
    config.idleGuard,
    {
      executeRelease: async () => {
        const extension = vscode.extensions.getExtension('google.colab');
        if (!extension) {
          throw new ColabDeckError('The official Google Colab extension is not installed.', {
            code: 'RELEASE_COMMAND_UNAVAILABLE',
            detail: 'Install and sign in to the official Colab extension, then retry.',
            recoverable: true,
            action: 'OPEN_SETTINGS',
          });
        }
        await extension.activate();
        await vscode.commands.executeCommand('colab.removeServer');
      },
      verifyRelease: async (server) => {
        const deadline = Date.now() + 5_000;
        do {
          if (!(await registry.validateServer(server.id))) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        } while (Date.now() < deadline);
        return false;
      },
      getKernelBusy: (serverId) => kernelClient.getStatus(serverId),
      showCountdownNotification: async (message, actions) => {
        const snoozeMinutes = Math.max(1, Math.round(config.idleGuard.snoozeMs / 60_000));
        const snoozeLabel = `Snooze ${snoozeMinutes}m`;
        const labels = actions.map((action) =>
          action === 'CANCEL' ? 'Cancel' : action === 'SNOOZE' ? snoozeLabel : 'Release now',
        );
        const picked = await vscode.window.showWarningMessage(message, ...labels);
        if (!picked) {
          return undefined;
        }
        if (picked === 'Cancel') {
          return 'CANCEL';
        }
        if (picked === snoozeLabel) {
          return 'SNOOZE';
        }
        return 'RELEASE_NOW';
      },
      showReleaseGuidance: async (server, message) => {
        const selection = await vscode.window.showInformationMessage(
          `${message} Server: "${server.label}". Confirm the release in the Colab dialog.`,
          'Open Colab',
        );
        if (selection === 'Open Colab') {
          void Promise.resolve(vscode.commands.executeCommand('colab.toolbarCommand')).catch(() => undefined);
        }
      },
      showError: async (_code, message) => {
        void vscode.window.showErrorMessage(message);
      },
      showInfo: async (message) => {
        void vscode.window.showInformationMessage(message);
      },
    },
  );

  const statusBar = new StatusBarController(logger, registry, store, idleGuard, monitoring);
  const toolbox = new ToolboxService(logger, monitoring, commandClient, kernelClient);
  const dashboard = new DashboardProvider(
    context,
    logger,
    registry,
    monitoring,
    idleGuard,
    errors,
    toolbox,
    () => config,
  );

  context.subscriptions.push(
    registry,
    errors,
    kernelClient,
    monitoring,
    idleGuard,
    statusBar,
    dashboard,
    vscode.window.registerWebviewViewProvider('colabdeck.dashboard', dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    ...registerCommands({
      logger,
      registry,
      monitoring,
      idleGuard,
      toolbox,
      errors,
      dashboard,
      snoozeMs: () => config.idleGuard.snoozeMs,
    }),
    monitoring.onSample(() => statusBar.update()),
    monitoring.onBatch(({ server, samples }) => {
      const latest = samples[samples.length - 1];
      if (latest) {
        void idleGuard.onSample(server, latest);
      }
      statusBar.update();
    }),
    monitoring.onServerConnected((server) => idleGuard.handleServerConnected(server)),
    monitoring.onProbeLost(({ serverId, reason }) => idleGuard.handleProbeLost(serverId, reason)),
    monitoring.onServerDisconnected(({ serverId, reason }) => idleGuard.handleServerDisconnected(serverId, reason)),
    monitoring.onError(({ error, serverId }) => errors.push(error, serverId)),
    idleGuard.onError((error) => errors.push(error, registry.currentId)),
    registry.onDidChangeSelection((server) => {
      const active = monitoring.getServer();
      if (active && active.id !== server?.id) {
        monitoring.stop(false);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void registry.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('colabdeck')) {
        return;
      }
      config = readConfig();
      logger.setLevel(config.logLevel);
      store.setInterval(config.sampleIntervalMs);
      idleGuard.updateSettings(config.idleGuard);
      dashboard.sendSnapshot();
    }),
  );

  await registry.refresh();
  const activationMs = Date.now() - activationStartedAt;
  logger.info(`[ColabDeck] activated in ${activationMs}ms`);
  return { activationMs };
}

export function deactivate(): void {
  // Disposable cleanup is handled by context.subscriptions.
}
