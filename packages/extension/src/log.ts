import * as vscode from 'vscode';
import { ColabDeckError } from '@colabdeck/shared';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private levelValue: LogLevel = 'info';

  constructor(name = 'ColabDeck', level: LogLevel = 'info') {
    this.channel = vscode.window.createOutputChannel(name);
    this.levelValue = level;
  }

  get level(): LogLevel {
    return this.levelValue;
  }

  setLevel(level: LogLevel): void {
    this.levelValue = level;
  }

  error(...values: readonly unknown[]): void {
    this.log('error', values);
  }

  warn(...values: readonly unknown[]): void {
    this.log('warn', values);
  }

  info(...values: readonly unknown[]): void {
    this.log('info', values);
  }

  debug(...values: readonly unknown[]): void {
    this.log('debug', values);
  }

  trace(...values: readonly unknown[]): void {
    this.log('trace', values);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private log(level: Exclude<LogLevel, 'off'>, values: readonly unknown[]): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.levelValue]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const rendered = values
      .map((value) => {
        if (value instanceof ColabDeckError) {
          // The stack only carries the headline; code/detail/cause are what identifies the failure.
          const parts = [this.render(value), `code=${value.code}`];
          if (value.detail) {
            parts.push(`detail=${value.detail}`);
          }
          return parts.join(' ');
        }
        if (value instanceof Error) {
          return this.render(value);
        }
        if (typeof value === 'object' && value !== null) {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }
        return String(value);
      })
      .join(' ');
    this.channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${rendered}`);
  }

  private render(error: Error): string {
    const message = error.stack ?? error.message;
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause === undefined || cause === error) {
      return message;
    }
    const causeText = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
    return `${message}\n  caused by: ${causeText}`;
  }
}
