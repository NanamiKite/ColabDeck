import * as vscode from 'vscode';
import { ColabDeckError } from '@colabdeck/shared';
import { activateColabExtension } from '../colabExtension.js';
import type { Logger } from '../log.js';
import type { ServerDescriptor } from '@colabdeck/shared';
import type { ProbePaths } from './probePaths.js';

export class ProbeInstaller {
  private static readonly WRITE_ATTEMPTS = 5;
  private static readonly WRITE_RETRY_DELAY_MS = 2_000;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {}

  async install(server: ServerDescriptor, paths: ProbePaths): Promise<void> {
    if (!(await activateColabExtension(this.logger))) {
      throw new ColabDeckError('The official Google Colab extension is not available.', {
        code: 'SERVER_UNAVAILABLE',
        detail: 'Install and sign in to the official Colab extension, then retry.',
        recoverable: true,
        action: 'OPEN_SETTINGS',
      });
    }
    const scriptUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'probe', 'colabdeck_probe.py');
    let script: Uint8Array;
    try {
      script = await vscode.workspace.fs.readFile(scriptUri);
    } catch (error) {
      throw new ColabDeckError('ColabDeck monitoring files are missing.', {
        code: 'PROBE_WRITE_FAILED',
        detail: 'Reinstall ColabDeck, then retry.',
        recoverable: false,
        action: 'OPEN_PROBE_LOG',
        cause: error,
      });
    }
    // Writing goes through the official colab:// provider, which needs the server to be authorized
    // and reachable. Check that first so an unreachable server fails fast with a clear reason
    // instead of a file write error.
    const content = vscode.Uri.from({ scheme: 'colab', authority: server.id, path: '/content' });
    try {
      await vscode.workspace.fs.stat(content);
    } catch (error) {
      const reason = error instanceof vscode.FileSystemError ? error.code : error instanceof Error ? error.message : String(error);
      this.logger.warn(`[ProbeInstaller] ${content.toString()} is not reachable (${reason})`);
      throw new ColabDeckError('The Colab server is not reachable.', {
        code: 'SERVER_UNAVAILABLE',
        detail: `Could not read ${content.toString()} through the official Colab extension (${reason}). Make sure the server is still assigned in the Colab extension, then retry.`,
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    // A freshly assigned runtime can take a few seconds before its Jupyter Contents API accepts
    // writes. Retry instead of surfacing a write error the user cannot act on.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= ProbeInstaller.WRITE_ATTEMPTS; attempt += 1) {
      try {
        await this.prepare(paths, script);
        this.logger.info(`[ProbeInstaller] wrote ${paths.script.toString()} (${script.byteLength} bytes)`);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `[ProbeInstaller] attempt ${attempt}/${ProbeInstaller.WRITE_ATTEMPTS} failed: ${describeFsError(error)}`,
        );
        if (attempt < ProbeInstaller.WRITE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, ProbeInstaller.WRITE_RETRY_DELAY_MS));
        }
      }
    }
    throw this.writeError('prepare the monitoring directory', paths.root, lastError);
  }

  private async prepare(paths: ProbePaths, script: Uint8Array): Promise<void> {
    if (!(await this.isDirectory(paths.root))) {
      try {
        await vscode.workspace.fs.createDirectory(paths.root);
      } catch (error) {
        throw this.writeError('create the monitoring directory', paths.root, error);
      }
    }
    try {
      await vscode.workspace.fs.writeFile(paths.script, script);
    } catch (error) {
      throw this.writeError('write the monitoring script', paths.script, error);
    }
  }

  private async isDirectory(uri: vscode.Uri): Promise<boolean> {
    try {
      return (await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory ? true : false;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return false;
      }
      throw error;
    }
  }

  private writeError(action: string, uri: vscode.Uri, error: unknown): ColabDeckError {
    const detail =
      error instanceof vscode.FileSystemError
        ? `${error.code} while trying to ${action}: ${uri.toString()}`
        : `${error instanceof Error ? error.message : String(error)} while trying to ${action}: ${uri.toString()}`;
    return new ColabDeckError('ColabDeck could not prepare monitoring.', {
      code: 'PROBE_WRITE_FAILED',
      detail,
      recoverable: true,
      action: 'OPEN_PROBE_LOG',
      cause: error,
    });
  }
}

function describeFsError(error: unknown): string {
  if (error instanceof ColabDeckError) {
    return `${error.code}: ${error.detail ?? error.message}`;
  }
  if (error instanceof vscode.FileSystemError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
