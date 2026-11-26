import * as vscode from 'vscode';
import type { ServerDescriptor } from '@colabdeck/shared';
import { abbreviateId } from '@colabdeck/shared';
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
  private initialized = false;
  private readonly emitter = new vscode.EventEmitter<readonly ServerDescriptor[]>;
  private readonly selectionEmitter = new vscode.EventEmitter<ServerDescriptor | undefined>;
  readonly onDidChangeServers = this.emitter.event;
  readonly onDidChangeSelection = this.selectionEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.selectedId = null;
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

  async refresh(): Promise<readonly ServerDescriptor[]> {
    const mounted = this.discoverMountedFolders();
    const previousSelectedId = this.selectedId;
    const merged = mergeServers(mounted);
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
    if (!this.selectedId && merged.length > 0) {
      const first = merged[0];
      if (!first) return merged;
      this.selectedId = first.id;
      void this.context.globalState.update(LAST_SERVER_KEY, {
        id: this.selectedId,
        label: first.label,
      });
    }
    if (changed) {
      this.logger.info(
        `[ServerRegistry] servers=${merged.length} selected=${this.selectedId ?? 'none'} ids=${merged
          .map((server) => abbreviateId(server.id))
          .join(',')}`,
      );
      this.emitter.fire(merged);
      if (this.initialized && previousSelectedId !== this.selectedId) {
        this.selectionEmitter.fire(this.selected());
      }
    }
    this.initialized = true;
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

  dispose(): void {
    this.emitter.dispose();
    this.selectionEmitter.dispose();
  }
}
