import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { NotebookExecutionTarget } from './notebookExecution.js';
import { NotebookMonitoringService } from './notebookMonitoringService.js';

const mocks = vi.hoisted(() => ({
  activeNotebook: undefined as vscode.NotebookDocument | undefined,
  prepare: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('vscode', () => ({
  EventEmitter: class EventEmitter<Payload> {
    private readonly listeners = new Set<(payload: Payload) => void>();
    readonly event = (listener: (payload: Payload) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(payload: Payload): void {
      for (const listener of this.listeners) listener(payload);
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
  Uri: {
    joinPath: (_base: vscode.Uri, ...parts: string[]) => ({ fsPath: `/extension/${parts.join('/')}` }),
  },
  window: {
    get activeNotebookEditor() {
      return mocks.activeNotebook ? { notebook: mocks.activeNotebook } : undefined;
    },
  },
  workspace: { isTrusted: true },
}));

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('./notebookExecution.js', () => ({
  NotebookExecutionError: class NotebookExecutionError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
  prepareNotebookExecution: mocks.prepare,
}));

const notebookUri = { path: '/workspace/colab.ipynb', toString: () => 'file:///workspace/colab.ipynb' } as vscode.Uri;
const otherUri = { path: '/workspace/other.ipynb', toString: () => 'file:///workspace/other.ipynb' } as vscode.Uri;

function notebook(uri = notebookUri): vscode.NotebookDocument {
  return { uri, notebookType: 'jupyter-notebook', isClosed: false } as vscode.NotebookDocument;
}

function target(execute: NotebookExecutionTarget['execute']): NotebookExecutionTarget {
  return { uri: notebookUri, execute };
}

function service() {
  return new NotebookMonitoringService(
    { fsPath: '/extension' } as vscode.Uri,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    () => ({ sampleIntervalMs: 5_000 } as never),
  );
}

beforeEach(() => {
  mocks.activeNotebook = notebook();
  mocks.prepare.mockReset();
  mocks.readFile.mockReset().mockResolvedValue('def start(*args): return "unused"');
});

describe('NotebookMonitoringService lifecycle', () => {
  it('allows starting before a target exists', () => {
    const monitor = service();

    expect(monitor.view.canStart).toBe(true);
    expect(monitor.view.canSync).toBe(false);
    expect(monitor.view.canStop).toBe(false);
  });

  it('keeps a recording session when stop runs from another notebook', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(JSON.stringify('/tmp/colabdeck-notebook-100-200-300/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
      .mockResolvedValueOnce(JSON.stringify({ sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stopped: true }));
    mocks.prepare.mockResolvedValue(target(execute));
    const monitor = service();

    await monitor.start();
    expect(monitor.view.state).toBe('recording');
    expect(monitor.view.canStop).toBe(true);

    mocks.activeNotebook = notebook(otherUri);
    await monitor.stop();
    expect(monitor.view.state).toBe('recording');
    expect(monitor.view.canStop).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(monitor.view.message).toContain('Return to the notebook');

    mocks.activeNotebook = notebook();
    await monitor.stop();
    expect(monitor.view.state).toBe('idle');
    expect(monitor.view.canStart).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('retains the session after a stop execution failure for retry', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(JSON.stringify('/tmp/colabdeck-notebook-100-200-300/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
      .mockRejectedValueOnce(new Error('kernel busy'))
      .mockResolvedValueOnce(JSON.stringify({ sessionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', stopped: true }));
    mocks.prepare.mockResolvedValue(target(execute));
    const monitor = service();

    await monitor.start();
    await monitor.stop();
    expect(monitor.view.state).toBe('recording');
    expect(monitor.view.canStop).toBe(true);
    expect(monitor.view.message).toBe('kernel busy');

    await monitor.stop();
    expect(monitor.view.state).toBe('idle');
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
