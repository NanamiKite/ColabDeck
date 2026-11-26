import * as vscode from 'vscode';
import type { Logger } from './log.js';

export const COLAB_EXTENSION_ID = 'google.colab';
export const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';

export async function activateColabExtension(logger?: Logger): Promise<boolean> {
  const extension = vscode.extensions.getExtension(COLAB_EXTENSION_ID);
  if (!extension) {
    logger?.warn('[ColabDeck] official Google Colab extension is not installed');
    return false;
  }
  try {
    await extension.activate();
    return true;
  } catch (error) {
    logger?.error('[ColabDeck] failed to activate the official Colab extension', error);
    return false;
  }
}

export async function executeColabCommand(command: string, ...args: readonly unknown[]): Promise<unknown> {
  return vscode.commands.executeCommand(command, ...args);
}

export function isTerminalLaunchEnabled(): boolean {
  return vscode.workspace.getConfiguration('colab').get<boolean>('terminal', true);
}
