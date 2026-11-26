import { ColabDeckError } from '@colabdeck/shared';
import type { JupyterApiKernel, JupyterKernelService } from './api.js';
import { findColabKernel, getJupyterKernelService } from './api.js';
import type { Logger } from '../log.js';

const STATUS_CACHE_MS = 5_000;

interface KernelStatusEntry {
  readonly atMs: number;
  readonly status: boolean | null;
}

export class KernelClient {
  private service: JupyterKernelService | null | undefined;
  private servicePromise: Promise<JupyterKernelService | undefined> | null = null;
  private readonly statusCache = new Map<string, KernelStatusEntry>();

  constructor(private readonly logger: Logger) {}

  async getService(): Promise<JupyterKernelService | undefined> {
    if (this.service !== undefined) {
      return this.service ?? undefined;
    }
    if (!this.servicePromise) {
      this.servicePromise = getJupyterKernelService()
        .then((service) => {
          this.service = service ?? null;
          if (!service) {
            this.logger.warn('[KernelClient] Jupyter Kernel API is unavailable or access was denied');
          }
          return service;
        })
        .catch((error) => {
          this.service = null;
          this.logger.warn('[KernelClient] failed to access Jupyter Kernel API', error);
          return undefined;
        });
    }
    return this.servicePromise;
  }

  async getStatus(serverId: string): Promise<boolean | null> {
    const cached = this.statusCache.get(serverId);
    if (cached && Date.now() - cached.atMs < STATUS_CACHE_MS) {
      return cached.status;
    }
    const service = await this.getService();
    if (!service) {
      return null;
    }
    try {
      const kernel = await findColabKernel(service, serverId);
      const status = kernel?.status === 'busy' ? true : kernel?.status === 'idle' ? false : null;
      this.statusCache.set(serverId, { atMs: Date.now(), status });
      return status;
    } catch (error) {
      this.logger.debug('[KernelClient] failed to read kernel status', error);
      return null;
    }
  }

  async clearCudaCache(serverId: string): Promise<string> {
    const service = await this.getService();
    if (!service) {
      throw new ColabDeckError('Notebook access is unavailable.', {
        code: 'CUDA_CACHE_KERNEL_UNAVAILABLE',
        detail: 'Allow ColabDeck to access the notebook kernel in Settings, then retry.',
        recoverable: true,
        action: 'OPEN_SETTINGS',
      });
    }
    const kernel = await findColabKernel(service, serverId);
    if (!kernel) {
      throw new ColabDeckError('No active notebook was found for this server.', {
        code: 'NO_ACTIVE_COLAB_KERNEL',
        detail: 'Start the notebook kernel first, then retry.',
        recoverable: true,
        action: 'RETRY',
      });
    }
    if (kernel.status === 'busy') {
      throw new ColabDeckError('The notebook kernel is busy. Wait for the current cell to finish.', {
        code: 'CUDA_CACHE_KERNEL_BUSY',
        recoverable: true,
        action: 'NONE',
      });
    }
    if (!kernel.executeCode) {
      throw new ColabDeckError('Notebook execution is unavailable.', {
        code: 'CUDA_CACHE_KERNEL_UNAVAILABLE',
        recoverable: true,
        action: 'OPEN_SETTINGS',
      });
    }
    const code = [
      'import torch',
      'if not torch.cuda.is_available():',
      '    print("CUDA is not available")',
      'else:',
      '    torch.cuda.empty_cache()',
      '    print("CUDA cache cleared.")',
    ].join('\n');
    let text = '';
    try {
      for await (const output of kernel.executeCode(code)) {
        for (const item of output.items ?? []) {
          if (item.mime === 'text/plain' && typeof item.data === 'string') {
            text += item.data;
          } else if (item.mime === 'text/plain' && item.data instanceof Uint8Array) {
            text += new TextDecoder().decode(item.data);
          }
        }
      }
    } catch (error) {
      throw new ColabDeckError('Could not clear the CUDA cache.', {
        code: 'CUDA_CACHE_KERNEL_UNAVAILABLE',
        detail: error instanceof Error ? error.message : String(error),
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    return text.includes('CUDA is not available') ? 'CUDA is not available.' : 'CUDA cache cleared.';
  }

  dispose(): void {
    this.statusCache.clear();
  }
}
