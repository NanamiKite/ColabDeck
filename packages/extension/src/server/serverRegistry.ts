import * as vscode from 'vscode';
import type { ServerDescriptor } from '@colabdeck/shared';
import { abbreviateId } from '@colabdeck/shared';
import { getJupyterKernelService, isRecord, readColabServerHandle } from '../jupyter/api.js';
import type { Logger } from '../log.js';
import { mergeServers } from './merge.js';

const LAST_SERVER_KEY = 'colabdeck.server.last';

export interface PersistedServer {
  readonly id: string;
  readonly label: string;
}

export class ServerRegistry implements vscode.Disposable {
  private servers: readonly ServerDescriptor[] = [];
  private selectedId: string | null;
  private readonly emitter = new vscode.EventEmitter<readonly ServerDescriptor[]>;
  private readonly selectionEmitter = new vscode.EventEmitter<ServerDescriptor | undefined>;
  readonly onDidChangeServers = this.emitter.event;
  readonly onDidChangeSelection = this.selectionEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    const persisted = context.globalState.get<PersistedServer | undefined>(LAST_SERVER_KEY, undefined);
    this.selectedId = persisted?.id ?? null;
  }

  get all(): readonly ServerDescriptor[] {
    return this.servers;
  }

  get currentId(): string | null {
    return this.selectedId;
  }

  selected(): ServerDescriptor | undefined {
    return this.servers.find((server) => server.id === this.selectedId);
  }

  async refresh(options: { readonly discoverKernelApi?: boolean } = {}): Promise<readonly ServerDescriptor[]> {
    const mounted = this.discoverMountedFolders();
    const persisted = await this.discoverPersisted(mounted);
    const kernelApi = options.discoverKernelApi ? await this.discoverKernelApi() : [];
    const merged = mergeServers(mounted, kernelApi, persisted);
    const changed =
      merged.length !== this.servers.length ||
      merged.some((server, index) => {
        const previous = this.servers[index];
        return (
          !previous ||
          previous.id !== server.id ||
          previous.label !== server.label ||
          previous.source !== server.source ||
          previous.kernelApiAvailable !== server.kernelApiAvailable
        );
      });
    this.servers = merged;
    if (this.selectedId && !merged.some((server) => server.id === this.selectedId)) {
      this.selectedId = null;
    }
    if (!this.selectedId) {
      this.selectedId = merged[0]?.id ?? null;
      if (this.selectedId) {
        void this.context.globalState.update(LAST_SERVER_KEY, { id: this.selectedId, label: merged[0]?.label ?? '' });
      }
    }
    if (changed) {
      this.logger.info(
        `[ServerRegistry] servers=${merged.length} selected=${this.selectedId ?? 'none'} ids=${merged
          .map((server) => abbreviateId(server.id))
          .join(',')}`,
      );
      this.emitter.fire(merged);
      this.selectionEmitter.fire(this.selected());
    }
    return merged;
  }

  select(serverId: string): void {
    if (!this.servers.some((server) => server.id === serverId)) {
      return;
    }
    if (this.selectedId === serverId) {
      return;
    }
    this.selectedId = serverId;
    const server = this.selected();
    void this.context.globalState.update(LAST_SERVER_KEY, { id: serverId, label: server?.label ?? '' });
    this.selectionEmitter.fire(server);
  }

  async validateServer(serverId: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.from({ scheme: 'colab', authority: serverId, path: '/content' }));
      return true;
    } catch (error) {
      const reason = error instanceof vscode.FileSystemError ? error.code : error instanceof Error ? error.message : String(error);
      this.logger.debug(`[ServerRegistry] server ${abbreviateId(serverId)} is not reachable (${reason})`);
      return false;
    }
  }

  /**
   * A freshly assigned runtime needs a moment before its Jupyter Contents API answers. Give the
   * remembered id a few short tries before deciding it is gone.
   */
  private async waitForServer(serverId: string, attempts = 3, delayMs = 1_000): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await this.validateServer(serverId)) {
        return true;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  private discoverMountedFolders(): ServerDescriptor[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders
      .filter((folder) => folder.uri.scheme === 'colab' && folder.uri.authority.length > 0)
      .map((folder) => ({
        id: folder.uri.authority,
        label: folder.name.length > 0 ? folder.name : `Colab ${abbreviateId(folder.uri.authority)}`,
        source: 'mounted-folder' as const,
        notebookUri: null,
        jupyterBaseUrl: null,
        kernelApiAvailable: false,
      }));
  }

  /**
   * The remembered server is only a hint. Runtime ids change whenever a server is released or
   * reassigned, and the official extension removes the stale workspace folder on its side, so a
   * remembered id that nothing else lists is usually dead. Only keep it while the official
   * colab:// provider still resolves it; otherwise drop it so the dashboard shows a clean
   * "no server" state instead of auto-starting monitoring against a ghost.
   */
  private async discoverPersisted(mounted: readonly ServerDescriptor[]): Promise<ServerDescriptor[]> {
    const persisted = this.context.globalState.get<PersistedServer | undefined>(LAST_SERVER_KEY, undefined);
    if (!persisted?.id) {
      return [];
    }
    const alreadyListed = mounted.some((server) => server.id === persisted.id);
    if (!alreadyListed && !(await this.waitForServer(persisted.id))) {
      this.logger.warn(`[ServerRegistry] forgot unreachable server ${abbreviateId(persisted.id)}`);
      await this.context.globalState.update(LAST_SERVER_KEY, undefined);
      return [];
    }
    return [
      {
        id: persisted.id,
        label: persisted.label || `Colab ${abbreviateId(persisted.id)}`,
        source: 'persisted',
        notebookUri: null,
        jupyterBaseUrl: null,
        kernelApiAvailable: false,
      },
    ];
  }

  private async discoverKernelApi(): Promise<ServerDescriptor[]> {
    const service = await getJupyterKernelService();
    if (!service?.getActiveKernels) {
      return [];
    }
    try {
      const kernels = await service.getActiveKernels();
      const servers = new Map<string, ServerDescriptor>();
      for (const kernel of kernels) {
        const serverId = readColabServerHandle(kernel.metadata);
        if (!serverId) {
          continue;
        }
        const metadata = isRecord(kernel.metadata) ? kernel.metadata : {};
        const kernelModel = isRecord(metadata.kernelModel) ? metadata.kernelModel : {};
        const baseUrl = typeof metadata.baseUrl === 'string' ? metadata.baseUrl : null;
        const label =
          typeof kernelModel.name === 'string' && kernelModel.name.length > 0
            ? kernelModel.name
            : `Colab ${abbreviateId(serverId)}`;
        servers.set(serverId, {
          id: serverId,
          label,
          source: 'kernel-api',
          notebookUri: kernel.uri.toString(),
          jupyterBaseUrl: baseUrl,
          kernelApiAvailable: true,
        });
      }
      return [...servers.values()];
    } catch (error) {
      this.logger.debug('[ServerRegistry] Kernel API discovery failed', error);
      return [];
    }
  }

  dispose(): void {
    this.emitter.dispose();
    this.selectionEmitter.dispose();
  }
}
