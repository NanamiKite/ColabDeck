import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { WEBVIEW_PROTOCOL_VERSION } from '@colabdeck/shared';
import type { HostToWebviewMessage, ServerDescriptor, WebviewToHostMessage } from '@colabdeck/shared';
import { readConfig } from '../config.js';
import type { ErrorCenter } from '../errors/errorCenter.js';
import type { IdleGuardService } from '../idleGuard/idleGuardService.js';
import type { Logger } from '../log.js';
import type { ServerRegistry } from '../server/serverRegistry.js';
import type { MonitoringService } from '../telemetry/monitoringService.js';
import type { ToolboxService } from '../toolbox/toolboxService.js';
import { DashboardProvider } from './dashboardProvider.js';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn(async () => undefined) }));

vi.mock('vscode', () => ({
  commands: { executeCommand },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  extensions: { getExtension: () => ({ activate: async () => undefined }) },
  Uri: { joinPath: () => ({ fsPath: '', toString: () => 'https://webview.example' }) },
}));

vi.mock('node:fs/promises', () => ({ readFile: async () => '<html><head></head></html>' }));

const mountedServer: ServerDescriptor = {
  id: 'runtime-1',
  label: 'Colab GPU',
  source: 'mounted-folder',
  notebookUri: null,
  jupyterBaseUrl: null,
  kernelApiAvailable: false,
};

async function dashboard() {
  executeCommand.mockClear();
  const subscribe = () => ({ dispose: () => undefined });
  const config = readConfig();
  const messages: HostToWebviewMessage[] = [];
  const registry = {
    all: [mountedServer],
    currentId: mountedServer.id,
    selected: () => mountedServer,
    select: vi.fn(),
    refresh: vi.fn(async () => [mountedServer]),
    onDidChangeServers: subscribe,
    onDidChangeSelection: subscribe,
  };
  const monitoring = {
    start: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    getServer: () => null,
    onStatus: subscribe,
    onReset: subscribe,
    onSample: subscribe,
  };
  const provider = new DashboardProvider(
    {} as vscode.ExtensionContext,
    { warn: vi.fn() } as unknown as Logger,
    registry as unknown as ServerRegistry,
    monitoring as unknown as MonitoringService,
    {
      snapshot: { state: {}, countdown: null, recentTransitions: [] },
      onChange: subscribe,
      onError: subscribe,
    } as unknown as IdleGuardService,
    { list: () => [], onDidChange: subscribe } as unknown as ErrorCenter,
    {} as ToolboxService,
    () => config,
  );
  let receive: ((message: unknown) => void) | undefined;
  await provider.resolveWebviewView(
    {
      visible: true,
      onDidChangeVisibility: subscribe,
      webview: {
        cspSource: 'https://webview.example',
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (callback: (message: unknown) => void) => {
          receive = callback;
          return subscribe();
        },
        postMessage: async (message: HostToWebviewMessage) => {
          messages.push(message);
          return true;
        },
      },
    } as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken,
  );
  const post = async (message: WebviewToHostMessage | { type: 'RELOAD_WINDOW' }) => {
    receive?.(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { messages, registry, monitoring, post };
}

describe('dashboard monitoring actions', () => {
  it('reports a mounted runtime as disconnected until monitoring starts', async () => {
    const { messages, post, monitoring } = await dashboard();
    await post({ type: 'READY', protocol: WEBVIEW_PROTOCOL_VERSION });

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'SNAPSHOT',
      snapshot: expect.objectContaining({
        selectedServerId: mountedServer.id,
        connection: 'disconnected',
        probe: null,
        latest: null,
      }),
    }));
    expect(monitoring.start).not.toHaveBeenCalled();
  });

  it('does not launch monitoring from range changes, refresh, selection or mount', async () => {
    const { messages, post, registry, monitoring } = await dashboard();
    await post({ type: 'REQUEST_SNAPSHOT', requestId: 'range', range: '15m' });
    await post({ type: 'REFRESH_SERVERS' });
    await post({ type: 'SELECT_SERVER', serverId: mountedServer.id });
    await post({ type: 'MOUNT_COLAB_SERVER' });

    expect(registry.refresh).toHaveBeenCalledTimes(2);
    expect(messages).toContainEqual({ type: 'TELEMETRY_BATCH', range: '15m', samples: [] });
    expect(executeCommand.mock.calls).toEqual([['colab.mountServer']]);
    expect(monitoring.start).not.toHaveBeenCalled();
    expect(monitoring.restart).not.toHaveBeenCalled();
  });

  it('starts or retries explicitly without forced restart or window reload', async () => {
    const { messages, post, monitoring } = await dashboard();
    await post({ type: 'START_MONITORING' });
    await post({ type: 'RETRY_PROBE' });
    await post({ type: 'READY', protocol: 1 });
    await post({ type: 'RELOAD_WINDOW' });

    expect(monitoring.start.mock.calls).toEqual([[mountedServer], [mountedServer]]);
    expect(monitoring.restart).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: 'PROTOCOL_MISMATCH',
      hostProtocol: WEBVIEW_PROTOCOL_VERSION,
      webviewProtocol: 1,
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
