import * as vscode from 'vscode';
import { ColabDeckError } from '@colabdeck/shared';
import { activateColabExtension } from '../colabExtension.js';
import type { Logger } from '../log.js';
import type { ServerDescriptor } from '@colabdeck/shared';
import type { ProbePaths } from './probePaths.js';

export class ProbeInstaller {
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
    try {
      await vscode.workspace.fs.createDirectory(paths.root);
      await vscode.workspace.fs.writeFile(paths.script, script);
      this.logger.info(`[ProbeInstaller] wrote ${paths.script.toString()} (${script.byteLength} bytes)`);
    } catch (error) {
      const detail = error instanceof vscode.FileSystemError ? error.code : error instanceof Error ? error.message : String(error);
      throw new ColabDeckError('ColabDeck could not prepare monitoring.', {
        code: 'PROBE_WRITE_FAILED',
        detail,
        recoverable: true,
        action: 'OPEN_PROBE_LOG',
        cause: error,
      });
    }
  }
}
