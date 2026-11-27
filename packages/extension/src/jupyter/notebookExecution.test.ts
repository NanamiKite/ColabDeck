import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { prepareNotebookExecution } from './notebookExecution.js';

const mocks = vi.hoisted(() => ({
  getExtension: vi.fn(),
  getKernel: vi.fn(),
  activate: vi.fn(),
  executeCommand: vi.fn(),
  workspace: { isTrusted: true },
  window: { activeNotebookEditor: undefined as vscode.NotebookEditor | undefined },
}));

vi.mock('vscode', () => ({
  extensions: { getExtension: mocks.getExtension },
  commands: { executeCommand: mocks.executeCommand },
  workspace: mocks.workspace,
  window: mocks.window,
}));

const uri = { toString: () => 'file:///workspace/test.ipynb' } as vscode.Uri;
const otherUri = { toString: () => 'file:///workspace/other.ipynb' } as vscode.Uri;
const stdout = 'application/vnd.code.notebook.stdout';
const stderr = 'application/vnd.code.notebook.stderr';

function notebookEditor(options: Partial<Pick<vscode.NotebookDocument, 'uri' | 'notebookType' | 'isClosed'>> = {}) {
  return { notebook: { uri, notebookType: 'jupyter-notebook', isClosed: false, ...options } } as vscode.NotebookEditor;
}

function output(mime: string, text: string): vscode.NotebookCellOutput {
  return { items: [{ mime, data: new TextEncoder().encode(text) }] };
}

async function* outputs(...values: vscode.NotebookCellOutput[]): AsyncIterable<vscode.NotebookCellOutput> {
  yield* values;
}

const executeCode = vi.fn<(code: string, token: vscode.CancellationToken) => AsyncIterable<vscode.NotebookCellOutput>>();

let kernel: { language: string; status: string; executeCode: typeof executeCode };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.isTrusted = true;
  mocks.window.activeNotebookEditor = notebookEditor();
  kernel = { language: 'python', status: 'idle', executeCode };
  mocks.getKernel.mockResolvedValue(kernel);
  mocks.getExtension.mockReturnValue({
    isActive: true,
    activate: mocks.activate,
    exports: { kernels: { getKernel: mocks.getKernel } },
  });
  executeCode.mockImplementation(() => outputs(output(stdout, 'ready\n')));
});

describe('prepareNotebookExecution', () => {
  it('prepares the exact active notebook without executing, activating Jupyter, or opening a picker', async () => {
    const target = await prepareNotebookExecution(uri);

    expect(target.uri.toString()).toBe(uri.toString());
    expect(mocks.getExtension).toHaveBeenCalledWith('ms-toolsai.jupyter');
    expect(mocks.getKernel).toHaveBeenCalledExactlyOnceWith(uri);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('does not activate an inactive Jupyter extension', async () => {
    mocks.getExtension.mockReturnValue({ isActive: false, activate: mocks.activate });

    await expect(prepareNotebookExecution(uri)).rejects.toMatchObject({ code: 'unsupported' });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.getKernel).not.toHaveBeenCalled();
  });

  it('rejects untrusted workspaces before looking up a kernel', async () => {
    mocks.workspace.isTrusted = false;

    await expect(prepareNotebookExecution(uri)).rejects.toMatchObject({ code: 'untrusted' });
    expect(mocks.getKernel).not.toHaveBeenCalled();
    expect(executeCode).not.toHaveBeenCalled();
  });

  it.each([
    ['different URI', { uri: otherUri }],
    ['closed notebook', { isClosed: true }],
    ['different notebook type', { notebookType: 'interactive' }],
  ])('does not look up a kernel for a %s', async (_name, options) => {
    mocks.window.activeNotebookEditor = notebookEditor(options);

    await expect(prepareNotebookExecution(uri)).rejects.toMatchObject({ code: 'notebook-unavailable' });
    expect(mocks.getKernel).not.toHaveBeenCalled();
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('rejects an absent, non-Python, or busy kernel without execution', async () => {
    mocks.getKernel.mockResolvedValueOnce(undefined);
    await expect(prepareNotebookExecution(uri)).rejects.toMatchObject({ code: 'kernel-unavailable' });
    kernel.language = 'javascript';
    await expect(prepareNotebookExecution(uri)).rejects.toMatchObject({ code: 'kernel-not-python' });
    kernel.language = 'python';
    kernel.status = 'busy';
    await expect(prepareNotebookExecution(uri)).rejects.toMatchObject({ code: 'kernel-busy' });
    expect(executeCode).not.toHaveBeenCalled();
  });

});

describe('NotebookExecutionTarget.execute', () => {
  it('rechecks the same kernel and joins only stdout and plain text output', async () => {
    const target = await prepareNotebookExecution(uri);
    executeCode.mockImplementation(() => outputs(
      output(stdout, 'first'),
      output(stderr, 'ignored'),
      output('text/html', '<p>ignored</p>'),
      output('text/plain', ' second'),
      output(stdout, '\nthird'),
    ));

    await expect(target.execute('print(1)')).resolves.toBe('first second\nthird');
    await expect(target.execute('print(2)')).resolves.toBe('first second\nthird');
    expect(mocks.getKernel).toHaveBeenCalledTimes(5);
    expect(executeCode).toHaveBeenCalledTimes(2);
    const token = executeCode.mock.calls[0]?.[1];
    expect(token?.isCancellationRequested).toBe(false);
    expect(executeCode.mock.calls[1]?.[1]).toBe(token);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects a replacement kernel before execution, even if its language and status match', async () => {
    const target = await prepareNotebookExecution(uri);
    mocks.getKernel.mockResolvedValue({ ...kernel });

    await expect(target.execute('print(1)')).rejects.toMatchObject({ code: 'target-changed' });
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('discards output if the kernel changes during execution', async () => {
    const target = await prepareNotebookExecution(uri);
    executeCode.mockImplementation(async function* () {
      mocks.getKernel.mockResolvedValue({ ...kernel });
      yield output(stdout, 'discard this result');
    });

    await expect(target.execute('print(1)')).rejects.toMatchObject({ code: 'target-changed' });
    expect(executeCode).toHaveBeenCalledTimes(1);
  });

  it('maps Jupyter authorization denial without retrying or opening a picker', async () => {
    const target = await prepareNotebookExecution(uri);
    executeCode.mockImplementation(async function* () {
      const error = new Error('Kernel access was revoked');
      error.name = 'vscode.jupyter.apiAccessRevoked';
      throw error;
    });

    await expect(target.execute('print(1)')).rejects.toMatchObject({ code: 'permission-denied' });
    expect(executeCode).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects oversized UTF-8 code before requesting execution', async () => {
    const target = await prepareNotebookExecution(uri);

    await expect(target.execute('界'.repeat(44_000))).rejects.toMatchObject({ code: 'invalid-code' });
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('limits the total UTF-8 bytes collected across multiple outputs', async () => {
    const target = await prepareNotebookExecution(uri);
    executeCode.mockImplementation(() => outputs(
      output(stdout, '界'.repeat(25_000)),
      output('text/plain', '界'.repeat(25_000)),
    ));

    await expect(target.execute('print(1)')).rejects.toMatchObject({ code: 'output-limit' });
  });

  it('does not release the kernel lock while draining excess output', async () => {
    const target = await prepareNotebookExecution(uri);
    let emitted!: () => void;
    let complete!: () => void;
    const overflowProduced = new Promise<void>((resolve) => { emitted = resolve; });
    const requestComplete = new Promise<void>((resolve) => { complete = resolve; });
    executeCode.mockImplementation(async function* () {
      yield output(stdout, 'x'.repeat(128 * 1024 + 1));
      emitted();
      await requestComplete;
    });
    const overflow = expect(target.execute('print(1)')).rejects.toMatchObject({ code: 'output-limit' });

    try {
      await overflowProduced;
      await expect(target.execute('print(2)')).rejects.toMatchObject({ code: 'kernel-busy' });
      expect(executeCode).toHaveBeenCalledTimes(1);
    } finally {
      complete();
      await overflow;
    }
  });
});
