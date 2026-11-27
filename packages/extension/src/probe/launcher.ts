import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { ColabDeckError, probeStatusSchema } from '@colabdeck/shared';
import { isTerminalLaunchEnabled } from '../colabExtension.js';
import type { Logger } from '../log.js';
import type { ProbeStatus, ServerDescriptor } from '@colabdeck/shared';
import type { ProbePaths } from './probePaths.js';
import { shellQuote } from './probePathUtils.js';

const STATUS_TIMEOUT_MS = 20_000;

export class TerminalProbeLauncher {
  constructor(private readonly logger: Logger) {}

  requireTerminal(server: ServerDescriptor): vscode.Terminal {
    if (!isTerminalLaunchEnabled()) {
      throw new ColabDeckError('Colab terminal is disabled.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail: 'Enable colab.terminal in VS Code Settings, open the official Colab terminal, then retry.',
        recoverable: true,
        action: 'RETRY',
      });
    }

    const terminals = vscode.window.terminals.filter((terminal) => {
      const options = terminal.creationOptions;
      return (
        !terminal.exitStatus && 'pty' in options &&
        options.iconPath instanceof vscode.ThemeIcon && options.iconPath.id === 'colab-logo' &&
        (options.name === server.label || options.name === server.id)
      );
    });
    const duplicateLabel = vscode.workspace.workspaceFolders?.some(({ uri, name }) =>
      uri.scheme === 'colab' && uri.authority !== server.id && name === server.label,
    );
    const terminal = terminals[0];
    if (terminals.length > 1 || (terminal && duplicateLabel && terminal.creationOptions.name !== server.id)) {
      throw new ColabDeckError('The Colab terminal is ambiguous.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail: `More than one terminal or mounted runtime matches "${server.label}". Leave one matching official Colab terminal open and use a unique runtime label.`,
        recoverable: true,
        action: 'RETRY',
      });
    }
    if (!terminal) {
      throw new ColabDeckError('Open the matching Colab terminal first.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail:
          `Open the official Colab terminal for "${server.label}" (Colab: Open Terminal), wait for it to connect, then retry monitoring. ` +
          'ColabDeck will not open, hide, or dispose terminals automatically.',
        recoverable: true,
        action: 'RETRY',
      });
    }
    return terminal;
  }

  async findRunningProbe(paths: ProbePaths, signal?: AbortSignal): Promise<ProbeStatus | null> {
    let status: ProbeStatus | null;
    try {
      status = await this.readStatus(paths, signal);
    } catch {
      signal?.throwIfAborted();
      return null;
    }
    signal?.throwIfAborted();
    if (!status || !this.isRunning(status, paths)) return null;
    const sampleAgeMs = Date.now() - status.lastSampleAtMs;
    return sampleAgeMs >= -5_000 && sampleAgeMs <= Math.max(15_000, status.sampleIntervalMs * 3) ? status : null;
  }

  async launch(server: ServerDescriptor, paths: ProbePaths, intervalMs: number, signal?: AbortSignal): Promise<ProbeStatus> {
    signal?.throwIfAborted();
    this.requireTerminal(server);
    const previous = await this.readStatus(paths, signal);
    signal?.throwIfAborted();
    const terminal = this.requireTerminal(server);
    const script = `${paths.dir}/colabdeck_probe.py`;
    const log = `${paths.dir}/probe.log`;
    const env = `COLABDECK_PROBE_DIR=${shellQuote(paths.dir)} COLABDECK_INTERVAL_MS=${intervalMs}`;
    const command =
      `cd /content && if command -v setsid >/dev/null 2>&1; then ` +
      `setsid nohup env ${env} python3 ${shellQuote(script)} </dev/null >>${shellQuote(log)} 2>&1 & ` +
      `else nohup env ${env} python3 ${shellQuote(script)} </dev/null >>${shellQuote(log)} 2>&1 & fi`;
    this.logger.info(`[ProbeLauncher] starting probe on ${server.label} (${server.id.slice(0, 8)})`);
    const launchStartedAtMs = Date.now();
    terminal.sendText(command, true);
    return this.waitForStatus(paths, previous?.bootId ?? null, launchStartedAtMs, signal);
  }

  private async readStatus(paths: ProbePaths, signal?: AbortSignal): Promise<ProbeStatus | null> {
    signal?.throwIfAborted();
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(paths.status);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return null;
      throw error;
    }
    signal?.throwIfAborted();
    try {
      const parsed = probeStatusSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private isRunning(status: ProbeStatus, paths: ProbePaths): boolean {
    return status.state === 'running' && status.probeDir === paths.dir && status.seq > 0 && status.lastSampleAtMs > 0;
  }

  private async waitForStatus(
    paths: ProbePaths,
    previousBootId: string | null,
    launchStartedAtMs: number,
    signal?: AbortSignal,
  ): Promise<ProbeStatus> {
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const status = await this.readStatus(paths, signal);
        signal?.throwIfAborted();
        if (
          status && this.isRunning(status, paths) &&
          (previousBootId !== null ? status.bootId !== previousBootId : status.startedAtMs >= launchStartedAtMs - 2_000)
        ) {
          return status;
        }
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
      }
      await delay(1_000, undefined, { signal });
    }
    signal?.throwIfAborted();
    const detail = lastError instanceof vscode.FileSystemError ? lastError.code : lastError instanceof Error ? lastError.message : null;
    const logTail = await this.readLogTail(paths);
    signal?.throwIfAborted();
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
