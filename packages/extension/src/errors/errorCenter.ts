import * as vscode from 'vscode';
import type { UiError } from '@colabdeck/shared';
import { ColabDeckError } from '@colabdeck/shared';

const DEDUPE_WINDOW_MS = 5 * 60_000;
const MAX_ERRORS = 5;

export class ErrorCenter implements vscode.Disposable {
  private errors: UiError[] = [];
  private readonly emitter = new vscode.EventEmitter<readonly UiError[]>();
  private readonly lastPushed = new Map<string, number>();
  readonly onDidChange = this.emitter.event;

  push(error: ColabDeckError, serverId: string | null = null): UiError | null {
    const key = `${error.code}:${serverId ?? ''}`;
    const now = Date.now();
    const previous = this.lastPushed.get(key);
    if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) {
      return null;
    }
    this.lastPushed.set(key, now);
    const uiError: UiError = {
      id: crypto.randomUUID(),
      message: error.message,
      detail: error.detail,
      recoverable: error.recoverable,
      action: error.action,
    };
    this.errors = [uiError, ...this.errors].slice(0, MAX_ERRORS);
    this.emitter.fire(this.errors);
    return uiError;
  }

  dismiss(id: string): void {
    const next = this.errors.filter((error) => error.id !== id);
    if (next.length === this.errors.length) {
      return;
    }
    this.errors = next;
    this.emitter.fire(this.errors);
  }

  list(): readonly UiError[] {
    return this.errors;
  }

  clear(): void {
    if (this.errors.length === 0) {
      return;
    }
    this.errors = [];
    this.emitter.fire(this.errors);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
