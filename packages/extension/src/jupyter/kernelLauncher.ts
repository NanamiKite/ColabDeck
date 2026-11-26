import * as vscode from 'vscode';
import { ColabDeckError, probeStatusSchema } from '@colabdeck/shared';
import type { ServerDescriptor } from '@colabdeck/shared';
import type { Logger } from '../log.js';
import type { ProbePaths } from '../probe/probePaths.js';
import type { KernelClient } from './kernelClient.js';

const STATUS_TIMEOUT_MS = 20_000;

/**
 * Starts the probe from inside the notebook kernel. The kernel already has a Python session on the
 * runtime, so this needs no terminal and never touches the official extension's QuickPick flow.
 */
export class KernelLauncher {
  constructor(
    private readonly logger: Logger,
    private readonly kernels: KernelClient,
  ) {}

  async isAvailable(server: ServerDescriptor): Promise<boolean> {
    const service = await this.kernels.getService();
    if (!service) {
      return false;
    }
    try {
      const kernel = await this.kernels.findKernel(server.id);
      return kernel?.executeCode !== undefined && kernel.status !== 'busy';
    } catch (error) {
      this.logger.debug('[KernelLauncher] kernel lookup failed', error);
      return false;
    }
  }

  async launch(server: ServerDescriptor, paths: ProbePaths, intervalMs: number): Promise<void> {
    const kernel = await this.kernels.findKernel(server.id);
    if (!kernel?.executeCode) {
      throw new ColabDeckError('No notebook kernel is available for this server.', {
        code: 'NO_ACTIVE_COLAB_KERNEL',
        detail: 'Start the notebook kernel first, or switch colabdeck.probe.launchMethod to "terminal".',
        recoverable: true,
        action: 'RETRY',
      });
    }
    if (kernel.status === 'busy') {
      throw new ColabDeckError('The notebook kernel is busy. Wait for the current cell to finish.', {
        code: 'CUDA_CACHE_KERNEL_BUSY',
        detail: 'ColabDeck starts its probe from the notebook kernel; run it again once the kernel is idle.',
        recoverable: true,
        action: 'RETRY',
      });
    }
    const previousBootId = await this.readPreviousBootId(paths);
    const script = `${paths.dir}/colabdeck_probe.py`;
    const log = `${paths.dir}/probe.log`;
    const code = [
      'import subprocess, sys',
      `cmd = [sys.executable, ${shellQuoteForPython(script)}]`,
      `env = {'COLABDECK_PROBE_DIR': ${shellQuoteForPython(paths.dir)}, 'COLABDECK_INTERVAL_MS': ${JSON.stringify(String(intervalMs))}}`,
      `log = open(${shellQuoteForPython(log)}, 'ab')`,
      "subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, cwd='/content')",
      "print('started')",
    ].join('\n');
    let output = '';
    try {
      for await (const chunk of kernel.executeCode(code)) {
        for (const item of chunk.items ?? []) {
          if (item.mime === 'text/plain' && typeof item.data === 'string') {
            output += item.data;
          } else if (item.mime === 'text/plain' && item.data instanceof Uint8Array) {
            output += new TextDecoder().decode(item.data);
          }
        }
      }
    } catch (error) {
      throw new ColabDeckError('Could not start the probe from the notebook kernel.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    if (!output.includes('started')) {
      throw new ColabDeckError('The notebook kernel did not start the probe.', {
        code: 'PROBE_LAUNCH_FAILED',
        detail: output.trim() || 'The kernel returned no output.',
        recoverable: true,
        action: 'OPEN_PROBE_LOG',
      });
    }
    await this.waitForStatus(paths, previousBootId);
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

  private async waitForStatus(paths: ProbePaths, previousBootId: string | null): Promise<void> {
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const raw = await vscode.workspace.fs.readFile(paths.status);
        const parsed = probeStatusSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
        if (parsed.success && parsed.data.bootId !== previousBootId) {
          return;
        }
      } catch {
        // The probe has not written its first status yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new ColabDeckError('The probe did not report a status in time.', {
      code: 'PROBE_STALE',
      detail: `Read ${paths.log.toString()} for details.`,
      recoverable: true,
      action: 'OPEN_PROBE_LOG',
    });
  }
}

function shellQuoteForPython(value: string): string {
  return JSON.stringify(value);
}
