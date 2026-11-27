import * as vscode from 'vscode';
import { ColabDeckError, probeStatusSchema } from '@colabdeck/shared';
import { isTerminalLaunchEnabled } from '../colabExtension.js';
import type { Logger } from '../log.js';
import type { ServerDescriptor } from '@colabdeck/shared';
import type { ProbePaths } from './probePaths.js';
import { shellQuote } from './probePathUtils.js';

const STATUS_TIMEOUT_MS = 20_000;

export class TerminalProbeLauncher {
  constructor(private readonly logger: Logger) {}

  async launch(server: ServerDescriptor, paths: ProbePaths, intervalMs: number): Promise<void> {
    if (!isTerminalLaunchEnabled()) {
      throw new ColabDeckError('Colab terminal is disabled.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail: 'Enable the Colab terminal in Settings, then retry.',
        recoverable: true,
        action: 'OPEN_SETTINGS',
      });
    }

    const terminal = this.findColabTerminal(server);
    if (!terminal) {
      throw new ColabDeckError('Open the matching Colab terminal first.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail:
          `Open the official Colab terminal for "${server.label}" (Colab: Open Terminal), then retry monitoring. ` +
          'ColabDeck will not open, hide, or dispose terminals automatically.',
        recoverable: true,
        action: 'RETRY',
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
