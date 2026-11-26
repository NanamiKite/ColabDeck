import { ColabDeckError, redactCommandLine } from '@colabdeck/shared';
import type { ProbeCommand, ServerDescriptor, ToolboxResult } from '@colabdeck/shared';
import type { KernelClient } from '../jupyter/kernelClient.js';
import type { Logger } from '../log.js';
import type { ProbeCommandClient } from '../probe/commandClient.js';
import type { MonitoringService } from '../telemetry/monitoringService.js';

export interface GpuProcessList {
  readonly processes: readonly {
    readonly pid: number;
    readonly name: string;
    readonly command: string | null;
    readonly usedMemoryBytes: number | null;
    readonly gpuUuid: string | null;
  }[];
  readonly source: 'nvidia-smi' | 'procfs' | 'none';
  readonly warning: string | null;
}

export class ToolboxService {
  constructor(
    private readonly logger: Logger,
    private readonly monitoring: MonitoringService,
    private readonly probeCommands: ProbeCommandClient,
    private readonly kernelClient: KernelClient,
  ) {}

  async listGpuProcesses(): Promise<GpuProcessList> {
    const context = this.requireContext();
    const result = await this.probeCommands.send(context.server.id, context.relativeDir, {
      type: 'LIST_GPU_PROCESSES',
      protocol: 1,
      requestId: crypto.randomUUID(),
      issuedAtMs: Date.now(),
    });
    const payload = result.result;
    if (!payload || payload.kind !== 'LIST_GPU_PROCESSES') {
      throw new ColabDeckError('GPU process data is unavailable.', {
        code: 'PROBE_COMMAND_REJECTED',
        recoverable: true,
        action: 'RETRY',
      });
    }
    return {
      processes: payload.processes.map((process) => ({
        pid: process.pid,
        name: process.name,
        command: redactCommandLine(process.command),
        usedMemoryBytes: process.usedMemoryBytes,
        gpuUuid: process.gpuUuid,
      })),
      source: payload.source,
      warning: payload.errors.length > 0 ? payload.errors.map((error) => error.message).join('; ') : null,
    };
  }

  async killProcess(pid: number): Promise<ToolboxResult> {
    const context = this.requireContext();
    const result = await this.probeCommands.send(context.server.id, context.relativeDir, {
      type: 'KILL_PROCESS',
      protocol: 1,
      requestId: crypto.randomUUID(),
      issuedAtMs: Date.now(),
      pid,
    });
    const payload = result.result;
    if (!payload || payload.kind !== 'KILL_PROCESS') {
      throw new ColabDeckError('The GPU process could not be stopped.', {
        code: 'PROBE_COMMAND_REJECTED',
        recoverable: true,
        action: 'RETRY',
      });
    }
    return {
      kind: 'KILL_PROCESS',
      ok: payload.killed || payload.alreadyDead,
      pid: payload.pid,
      alreadyDead: payload.alreadyDead,
      verified: payload.verified,
      message: payload.alreadyDead
        ? 'The process was already gone.'
        : payload.verified
          ? 'The process was terminated and verified.'
          : 'The kill signal was sent, but the process could not be verified.',
    };
  }

  async scanDisk(path: string, maxEntries = 50, maxDepth = 4): Promise<ToolboxResult> {
    const context = this.requireContext();
    const result = await this.probeCommands.send(context.server.id, context.relativeDir, {
      type: 'SCAN_DISK',
      protocol: 1,
      requestId: crypto.randomUUID(),
      issuedAtMs: Date.now(),
      path,
      maxEntries: Math.min(1000, Math.max(1, maxEntries)),
      maxDepth: Math.min(16, Math.max(0, maxDepth)),
    });
    const payload = result.result;
    if (!payload || payload.kind !== 'SCAN_DISK') {
      throw new ColabDeckError('Disk scan data is unavailable.', {
        code: 'PROBE_COMMAND_REJECTED',
        recoverable: true,
        action: 'RETRY',
      });
    }
    return {
      kind: 'SCAN_DISK',
      ok: true,
      path: payload.path,
      entries: payload.entries,
      truncated: payload.truncated,
      message: null,
    };
  }

  async clearCudaCache(): Promise<ToolboxResult> {
    const server = this.requireServer();
    const message = await this.kernelClient.clearCudaCache(server.id);
    return { kind: 'CLEAR_CUDA_CACHE', ok: true, message };
  }

  private requireServer(): ServerDescriptor {
    const server = this.monitoring.getServer();
    if (!server) {
      throw new ColabDeckError('No Colab server is selected.', {
        code: 'SERVER_ID_UNAVAILABLE',
        detail: 'Connect a Colab server and start monitoring first.',
        recoverable: true,
        action: 'RETRY',
      });
    }
    return server;
  }

  private requireContext(): { readonly server: ServerDescriptor; readonly relativeDir: string } {
    const server = this.requireServer();
    const paths = this.monitoring.getPaths();
    if (!paths) {
      throw new ColabDeckError('Monitoring is not ready for the selected server.', {
        code: 'PROBE_STALE',
        detail: 'Monitoring is not ready yet. Retry in a moment.',
        recoverable: true,
        action: 'RETRY',
      });
    }
    return { server, relativeDir: paths.relativeDir };
  }
}
