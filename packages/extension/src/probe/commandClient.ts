import * as vscode from 'vscode';
import { ColabDeckError, probeCommandResultSchema } from '@colabdeck/shared';
import type { ProbeCommand, ProbeCommandResult } from '@colabdeck/shared';
import type { Logger } from '../log.js';
import { buildCommandFileUri, buildCommandTempFileUri, buildResultFileUri } from './probePaths.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 300;

export class ProbeCommandClient {
  constructor(private readonly logger: Logger) {}

  async send(serverId: string, relativeDir: string, command: ProbeCommand, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeCommandResult> {
    const commandUri = buildCommandFileUri(serverId, relativeDir, command.requestId);
    const tempUri = buildCommandTempFileUri(serverId, relativeDir, command.requestId);
    const resultUri = buildResultFileUri(serverId, relativeDir, command.requestId);
    const payload = Buffer.from(JSON.stringify(command), 'utf8');
    try {
      await vscode.workspace.fs.writeFile(tempUri, payload);
      await vscode.workspace.fs.rename(tempUri, commandUri, { overwrite: true });
    } catch (error) {
      throw new ColabDeckError('Monitoring request could not be sent.', {
        code: 'PROBE_COMMAND_TIMEOUT',
        detail: error instanceof vscode.FileSystemError ? error.code : String(error),
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const raw = await vscode.workspace.fs.readFile(resultUri);
        const parsed = probeCommandResultSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
        if (!parsed.success) {
          lastError = parsed.error;
        } else if (parsed.data.requestId !== command.requestId) {
          lastError = new Error('result requestId mismatch');
        } else {
          try {
            await vscode.workspace.fs.delete(resultUri, { useTrash: false });
          } catch {
            // Best-effort cleanup; the probe also garbage-collects old results.
          }
          if (!parsed.data.ok) {
            throw new ColabDeckError(parsed.data.error?.message ?? 'Monitoring request was rejected.', {
              code: 'PROBE_COMMAND_REJECTED',
              detail: parsed.data.error?.code ?? null,
              recoverable: true,
              action: 'RETRY',
            });
          }
          return parsed.data;
        }
      } catch (error) {
        if (error instanceof ColabDeckError) {
          throw error;
        }
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    try {
      await vscode.workspace.fs.delete(commandUri, { useTrash: false });
    } catch {
      // best effort cleanup
    }
    throw new ColabDeckError('Monitoring request timed out.', {
      code: 'PROBE_COMMAND_TIMEOUT',
      detail: lastError instanceof Error ? lastError.message : null,
      recoverable: true,
      action: 'RETRY',
    });
  }

  async stop(serverId: string, relativeDir: string, timeoutMs = 3_000): Promise<boolean> {
    const requestId = crypto.randomUUID();
    try {
      await this.send(
        serverId,
        relativeDir,
        { type: 'STOP', protocol: 1, requestId, issuedAtMs: Date.now() },
        timeoutMs,
      );
      this.logger.info('[ProbeCommandClient] probe acknowledged STOP');
      return true;
    } catch (error) {
      this.logger.debug('[ProbeCommandClient] STOP was not acknowledged', error);
      return false;
    }
  }
}
