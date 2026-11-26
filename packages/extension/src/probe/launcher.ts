import * as vscode from 'vscode';
import { ColabDeckError, probeStatusSchema } from '@colabdeck/shared';
import { activateColabExtension, executeColabCommand, isTerminalLaunchEnabled } from '../colabExtension.js';
import type { Logger } from '../log.js';
import type { ServerDescriptor } from '@colabdeck/shared';
import type { ProbePaths } from './probePaths.js';
import { shellQuote } from './probePathUtils.js';

const TERMINAL_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 20_000;

export class TerminalProbeLauncher {
  constructor(private readonly logger: Logger) {}

  async launch(server: ServerDescriptor, paths: ProbePaths, intervalMs: number): Promise<void> {
    if (!(await activateColabExtension(this.logger))) {
      throw new ColabDeckError('The official Google Colab extension is not available.', {
        code: 'SERVER_UNAVAILABLE',
        recoverable: true,
        action: 'OPEN_SETTINGS',
      });
    }
    if (!isTerminalLaunchEnabled()) {
      throw new ColabDeckError('Colab terminal is disabled.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail: 'Enable the Colab terminal in Settings, then retry.',
        recoverable: true,
        action: 'OPEN_SETTINGS',
      });
    }

    const previousBootId = await this.readPreviousBootId(paths);
    const launchStartedAtMs = Date.now();
    try {
      await vscode.workspace.fs.delete(paths.status, { useTrash: false });
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
        throw new ColabDeckError('Could not reset the probe status.', {
          code: 'PROBE_WRITE_FAILED',
          detail: error instanceof Error ? error.message : String(error),
          recoverable: true,
          action: 'RETRY',
          cause: error,
        });
      }
    }
    const terminal = this.findColabTerminal(server) ?? (await this.openOfficialTerminal(server));
    try {
      const script = `${paths.dir}/colabdeck_probe.py`;
      const log = `${paths.dir}/probe.log`;
      const env = `COLABDECK_PROBE_DIR=${shellQuote(paths.dir)} COLABDECK_INTERVAL_MS=${intervalMs}`;
      const command =
        `cd /content && if command -v setsid >/dev/null 2>&1; then ` +
        `setsid nohup env ${env} python3 ${shellQuote(script)} </dev/null >>${shellQuote(log)} 2>&1 & ` +
        `else nohup env ${env} python3 ${shellQuote(script)} </dev/null >>${shellQuote(log)} 2>&1 & fi`;
      this.logger.info(`[ProbeLauncher] starting probe on ${server.label} (${server.id.slice(0, 8)})`);
      terminal.sendText(command, true);
      await this.waitForStatus(paths, STATUS_TIMEOUT_MS, previousBootId, launchStartedAtMs);
    } catch (error) {
      throw error;
    }
  }

  private findColabTerminal(server: ServerDescriptor): vscode.Terminal | null {
    return (
      vscode.window.terminals.find(
        (terminal) =>
          !terminal.exitStatus && (terminal.name === server.label || terminal.name === server.id),
      ) ?? null
    );
  }

  private async openOfficialTerminal(server: ServerDescriptor): Promise<vscode.Terminal> {
    const before = new Set(vscode.window.terminals);
    const waiter = this.waitForTerminal(server, before);
    try {
      await executeColabCommand('colab.openTerminal');
    } catch (error) {
      waiter.cancel();
      throw new ColabDeckError('Colab connection failed.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    return waiter.promise;
  }

  private waitForTerminal(
    server: ServerDescriptor,
    before: ReadonlySet<vscode.Terminal>,
  ): { readonly promise: Promise<vscode.Terminal>; readonly cancel: () => void } {
    let timer: NodeJS.Timeout | null = null;
    let subscription: vscode.Disposable | null = null;
    let settled = false;
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      subscription?.dispose();
      subscription = null;
    };
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const promise = new Promise<vscode.Terminal>((resolve, reject) => {
      timer = setTimeout(() => {
        finish(() => {
          reject(
            new ColabDeckError('Colab connection timed out.', {
              code: 'PROBE_LAUNCH_FAILED',
              detail: 'Select the matching Colab server in the dialog, then retry.',
              recoverable: true,
              action: 'RETRY',
            }),
          );
        });
      }, TERMINAL_TIMEOUT_MS);
      subscription = vscode.window.onDidOpenTerminal((terminal) => {
        if (before.has(terminal)) {
          return;
        }
        if (terminal.name === server.label || terminal.name === server.id) {
          finish(() => resolve(terminal));
        }
      });
    });
    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
      },
    };
  }

  private async readPreviousBootId(paths: ProbePaths): Promise<string | null> {
    try {
      const raw = await vscode.workspace.fs.readFile(paths.status);
      const parsed = probeStatusSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      return parsed.success ? parsed.data.bootId : null;
    } catch {
      return null;
    }
  }

  private async waitForStatus(
    paths: ProbePaths,
    timeoutMs: number,
    previousBootId: string | null,
    launchStartedAtMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const raw = await vscode.workspace.fs.readFile(paths.status);
        const text = new TextDecoder().decode(raw);
        const parsed = probeStatusSchema.safeParse(JSON.parse(text));
        if (
          parsed.success &&
          parsed.data.seq > 0 &&
          parsed.data.startedAtMs >= launchStartedAtMs - 2_000 &&
          (previousBootId === null || parsed.data.bootId !== previousBootId)
        ) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const detail = lastError instanceof vscode.FileSystemError ? lastError.code : lastError instanceof Error ? lastError.message : null;
    const logTail = await this.readLogTail(paths);
    throw new ColabDeckError('Monitoring did not start.', {
      code: 'PROBE_LAUNCH_FAILED',
      detail: [detail, logTail].filter(Boolean).join('\n'),
      recoverable: true,
      action: 'OPEN_PROBE_LOG',
    });
  }

  private async readLogTail(paths: ProbePaths): Promise<string | null> {
    try {
      const raw = await vscode.workspace.fs.readFile(paths.log);
      const text = new TextDecoder().decode(raw);
      return text.split('\n').slice(-12).join('\n');
    } catch {
      return null;
    }
  }
}
