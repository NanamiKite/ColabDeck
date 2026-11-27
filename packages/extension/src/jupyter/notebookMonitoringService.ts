import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { probeSampleSchema, toTelemetrySample } from '@colabdeck/shared';
import type { NotebookMonitorView, TelemetrySample } from '@colabdeck/shared';
import type { ColabDeckConfig } from '../config.js';
import type { Logger } from '../log.js';
import { NotebookExecutionError, prepareNotebookExecution, type NotebookExecutionTarget } from './notebookExecution.js';

export class NotebookMonitoringService implements vscode.Disposable {
  private target: NotebookExecutionTarget | null = null;
  private sessionId: string | null = null;
  private sessionDirectory: string | null = null;
  private notebookLabel: string | null = null;
  private samples: TelemetrySample[] = [];
  private state: NotebookMonitorView['state'] = 'idle';
  private message: string | null = null;
  private busy = false;
  private readonly emitter = new vscode.EventEmitter<NotebookMonitorView>();

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: Logger,
    private readonly configProvider: () => ColabDeckConfig,
  ) {}

  get view(): NotebookMonitorView {
    const active = this.isActiveNotebook();
    return {
      notebookLabel: this.notebookLabel,
      state: this.state,
      message: this.message,
      samples: this.samples,
      // Starting does not have a target yet.  Requiring `isActiveNotebook()`
      // here made the first start button permanently disabled because that
      // helper intentionally compares against the target created by start().
      canStart: this.hasActiveNotebook() && this.state === 'idle' && !this.busy,
      canSync: active && this.state === 'recording' && !this.busy && this.sessionId !== null,
      // Stop executes in the selected notebook kernel as well.  Do not offer
      // it for a different active notebook, otherwise a failed execution
      // would clear our local state while leaving the remote worker alive.
      canStop: active && this.state === 'recording' && !this.busy && this.sessionId !== null,
    };
  }

  async start(): Promise<void> {
    if (this.busy || this.state !== 'idle') return;
    this.busy = true;
    this.state = 'starting';
    this.message = null;
    this.emit();
    try {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (!notebook) throw new NotebookExecutionError('notebook-unavailable', 'Open the notebook connected to Colab, then retry.');
      this.target = await prepareNotebookExecution(notebook.uri);
      this.notebookLabel = path.basename(notebook.uri.path) || notebook.uri.path;
      const source = await fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'resources', 'probe', 'colabdeck_notebook.py').fsPath, 'utf8');
      const proposedSession = crypto.randomUUID().replaceAll('-', '');
      const result = await this.target.execute([
        'import json',
        "namespace = {'__name__': 'colabdeck_notebook'}",
        `exec(compile(${JSON.stringify(source)}, 'colabdeck_notebook.py', 'exec'), namespace)`,
        `print(json.dumps(namespace['start'](${JSON.stringify(proposedSession)}, ${this.configProvider().sampleIntervalMs}, ${JSON.stringify(source)})))`,
      ].join('\n'));
      const directory = extractJsonString(result);
      this.sessionId = path.basename(directory);
      if (!/^[0-9a-f]{32}$/.test(this.sessionId)) throw new Error('Notebook sampler returned an invalid session.');
      if (!/^\/tmp\/colabdeck-notebook-\d+-\d+-\d+\/[0-9a-f]{32}$/.test(directory)) {
        throw new Error('Notebook sampler returned an invalid private directory.');
      }
      this.sessionDirectory = directory;
      this.samples = [];
      this.state = 'recording';
      this.message = 'Recording in the background. Sync samples after the notebook becomes idle.';
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  async sync(): Promise<void> {
    if (this.busy || this.state !== 'recording' || !this.target || !this.sessionId) return;
    this.busy = true;
    this.state = 'syncing';
    this.emit();
    try {
      const afterSeq = this.samples[this.samples.length - 1]?.seq ?? 0;
      const result = await this.target.execute([
        'import json, runpy',
        `directory = ${JSON.stringify(this.sessionDirectory)}`,
        `session_id = ${JSON.stringify(this.sessionId)}`,
        `after_seq = ${afterSeq}`,
        'payload = runpy.run_path(directory + "/colabdeck_notebook.py")["read"](session_id, after_seq, 32)',
        'print(json.dumps(payload))',
      ].join('\n'));
      const payload = extractJsonObject(result);
      if (payload.sessionId !== this.sessionId || payload.active !== true || !Array.isArray(payload.samples)) {
        throw new Error('The notebook sampler is no longer active.');
      }
      const nextSamples = payload.samples.flatMap((item) => {
        const parsed = probeSampleSchema.safeParse(item);
        return parsed.success ? [toTelemetrySample(parsed.data, Date.now())] : [];
      });
      this.samples = [...this.samples, ...nextSamples].slice(-3600);
      this.message = nextSamples.length === 0 ? 'No new samples were available.' : `Synced ${nextSamples.length} samples.`;
    } catch (error) {
      // Keep the target/session on a sync failure.  In particular, a notebook
      // switch during execution is recoverable by returning to the monitored
      // notebook; clearing the session here would orphan its sampler worker.
      this.state = 'recording';
      this.message = error instanceof Error ? error.message : String(error);
      this.logger.warn('[NotebookMonitoring] unable to sync notebook monitoring', error);
    } finally {
      this.busy = false;
      if (this.state === 'syncing') this.state = 'recording';
      this.emit();
    }
  }

  async stop(): Promise<void> {
    if (this.busy || this.state !== 'recording') return;
    const target = this.target;
    const directory = this.sessionDirectory;
    const sessionId = this.sessionId;
    if (!target || !directory || !sessionId) return;
    if (!this.isActiveNotebook()) {
      this.message = 'Return to the notebook being monitored before stopping.';
      this.emit();
      return;
    }

    this.busy = true;
    this.state = 'stopping';
    this.message = null;
    this.emit();
    try {
      await target.execute([
        'import json, runpy',
        `directory = ${JSON.stringify(directory)}`,
        `session_id = ${JSON.stringify(sessionId)}`,
        'print(json.dumps(runpy.run_path(directory + "/colabdeck_notebook.py")["stop"](session_id)))',
      ].join('\n'));
      this.clearSession('Notebook monitoring stopped.');
    } catch (error) {
      // Keep the session available for a retry.  This is important when the
      // kernel is busy or the active editor changed while the request ran.
      this.state = 'recording';
      this.message = error instanceof Error ? error.message : String(error);
      this.logger.warn('[NotebookMonitoring] sampler stop request failed', error);
    } finally {
      this.busy = false;
      if (this.state === 'stopping') this.state = 'recording';
      this.emit();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private isActiveNotebook(): boolean {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    return notebook !== undefined && !notebook.isClosed && this.target?.uri.toString() === notebook.uri.toString();
  }

  private hasActiveNotebook(): boolean {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    return notebook !== undefined && !notebook.isClosed && notebook.notebookType === 'jupyter-notebook';
  }

  private clearSession(message: string): void {
    this.sessionId = null;
    this.sessionDirectory = null;
    this.target = null;
    this.state = 'idle';
    this.message = message;
    this.samples = [];
  }

  private fail(error: unknown): void {
    this.state = 'idle';
    this.sessionId = null;
    this.sessionDirectory = null;
    this.target = null;
    this.samples = [];
    this.message = error instanceof Error ? error.message : String(error);
    this.logger.warn('[NotebookMonitoring] unable to start or sync notebook monitoring', error);
  }

  private emit(): void {
    this.emitter.fire(this.view);
  }
}

function extractJsonString(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value: unknown = JSON.parse(lines[index] ?? '');
      if (typeof value === 'string') return value;
    } catch {
      continue;
    }
  }
  throw new Error('The notebook sampler did not return a session directory.');
}

function extractJsonObject(output: string): { readonly sessionId?: unknown; readonly samples?: unknown; readonly active?: unknown } {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value: unknown = JSON.parse(lines[index] ?? '');
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as { readonly sessionId?: unknown; readonly samples?: unknown; readonly active?: unknown };
      }
    } catch {
      continue;
    }
  }
  throw new Error('The notebook sampler returned no synchronization payload.');
}
