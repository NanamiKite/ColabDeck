import * as vscode from 'vscode';

const MAX_CODE_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const STDOUT_MIME = 'application/vnd.code.notebook.stdout';
const NEVER_CANCEL: vscode.CancellationToken = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
});

interface NotebookKernel {
  readonly language: string;
  readonly status: string;
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<vscode.NotebookCellOutput>;
}

interface JupyterKernels {
  getKernel(uri: vscode.Uri): Thenable<NotebookKernel | undefined>;
}

interface JupyterPublicApi {
  readonly kernels?: JupyterKernels;
}

const executing = new WeakSet<NotebookKernel>();

export type NotebookExecutionErrorCode =
  | 'unsupported'
  | 'untrusted'
  | 'notebook-unavailable'
  | 'kernel-unavailable'
  | 'kernel-not-python'
  | 'kernel-busy'
  | 'permission-denied'
  | 'target-changed'
  | 'invalid-code'
  | 'output-limit'
  | 'execution-failed';

export class NotebookExecutionError extends Error {
  constructor(readonly code: NotebookExecutionErrorCode, message: string) {
    super(message);
    this.name = 'NotebookExecutionError';
  }
}

export interface NotebookExecutionTarget {
  readonly uri: vscode.Uri;
  execute(code: string): Promise<string>;
}

function assertTrusted(): void {
  if (!vscode.workspace.isTrusted) {
    throw new NotebookExecutionError('untrusted', 'Notebook execution requires a trusted workspace.');
  }
}

function assertSameNotebook(notebook: vscode.NotebookDocument): void {
  assertTrusted();
  if (notebook.isClosed || vscode.window.activeNotebookEditor?.notebook !== notebook) {
    throw new NotebookExecutionError('target-changed', 'The active notebook changed. Return to the notebook and retry.');
  }
}

function requireKernels(): JupyterKernels {
  const extension = vscode.extensions.getExtension<JupyterPublicApi>('ms-toolsai.jupyter');
  const kernels = extension?.isActive ? extension.exports?.kernels : undefined;
  if (typeof kernels?.getKernel !== 'function') {
    throw new NotebookExecutionError('unsupported', 'The active Jupyter extension does not expose the public notebook kernel API.');
  }
  return kernels;
}

async function lookupKernel(kernels: JupyterKernels, uri: vscode.Uri): Promise<NotebookKernel | undefined> {
  try {
    return await kernels.getKernel(uri);
  } catch {
    throw new NotebookExecutionError('kernel-unavailable', 'Jupyter could not look up the running notebook kernel.');
  }
}

function assertIdle(kernel: NotebookKernel): void {
  if (kernel.status === 'busy' || kernel.status === 'starting' || kernel.status === 'restarting' ||
      kernel.status === 'autorestarting' || executing.has(kernel)) {
    throw new NotebookExecutionError('kernel-busy', 'Wait for the notebook kernel to become idle, then retry.');
  }
  if (kernel.status !== 'idle') {
    throw new NotebookExecutionError('kernel-unavailable', 'The notebook kernel is not ready to execute code.');
  }
}

async function collectOutput(kernel: NotebookKernel, code: string): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  let failed = false;
  let overflow = false;
  try {
    for await (const output of kernel.executeCode(code, NEVER_CANCEL)) {
      failed ||= output.items.some((item) => item.mime === 'application/vnd.code.notebook.error');
      if (overflow) continue;
      const mime = output.items.some((item) => item.mime === STDOUT_MIME) ? STDOUT_MIME : 'text/plain';
      for (const item of output.items) {
        if (item.mime !== mime || !(item.data instanceof Uint8Array) || item.data.byteLength === 0) continue;
        bytes += item.data.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) {
          overflow = true;
          break;
        }
        chunks.push(decoder.decode(item.data, { stream: true }));
      }
    }
  } catch (error) {
    if (error instanceof NotebookExecutionError) throw error;
    if (error instanceof Error && error.name === 'vscode.jupyter.apiAccessRevoked') {
      throw new NotebookExecutionError('permission-denied', 'Jupyter did not grant permission to execute code in this notebook.');
    }
    throw new NotebookExecutionError('execution-failed', 'Jupyter could not execute the ColabDeck request.');
  }
  if (overflow) {
    throw new NotebookExecutionError('output-limit', 'Jupyter returned more output than ColabDeck can read.');
  }
  if (failed) {
    throw new NotebookExecutionError('execution-failed', 'The notebook kernel reported an error running the ColabDeck request.');
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

export async function prepareNotebookExecution(uri: vscode.Uri): Promise<NotebookExecutionTarget> {
  assertTrusted();
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (!notebook || notebook.isClosed || notebook.notebookType !== 'jupyter-notebook' ||
      notebook.uri.toString() !== uri.toString()) {
    throw new NotebookExecutionError('notebook-unavailable', 'Open the requested Jupyter notebook and retry.');
  }
  const kernels = requireKernels();
  const kernel = await lookupKernel(kernels, uri);
  assertSameNotebook(notebook);
  if (!kernel || typeof kernel.executeCode !== 'function') {
    throw new NotebookExecutionError('kernel-unavailable', 'Run a cell in the selected notebook kernel first.');
  }
  if (kernel.language?.toLowerCase() !== 'python') {
    throw new NotebookExecutionError('kernel-not-python', 'ColabDeck requires a Python notebook kernel.');
  }
  assertIdle(kernel);

  const assertSameTarget = async (): Promise<void> => {
    assertSameNotebook(notebook);
    const current = await lookupKernel(kernels, uri);
    assertSameNotebook(notebook);
    if (current !== kernel) {
      throw new NotebookExecutionError('target-changed', 'The notebook kernel changed. Confirm the selected kernel and retry.');
    }
  };

  return {
    uri,
    async execute(code: string): Promise<string> {
      if (typeof code !== 'string' || code.length > MAX_CODE_BYTES || !code.trim() ||
          Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
        throw new NotebookExecutionError('invalid-code', 'The ColabDeck notebook request is empty or too large.');
      }
      await assertSameTarget();
      assertIdle(kernel);
      executing.add(kernel);
      try {
        const output = await collectOutput(kernel, code);
        await assertSameTarget();
        return output;
      } finally {
        executing.delete(kernel);
      }
    },
  };
}
