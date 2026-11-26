import * as vscode from 'vscode';

export interface JupyterOutputItem {
  readonly mime?: string;
  readonly data?: unknown;
}

export interface JupyterOutput {
  readonly items?: readonly JupyterOutputItem[];
}

export interface JupyterApiKernel {
  readonly status?: string;
  readonly executeCode?: (code: string) => AsyncIterable<JupyterOutput>;
}

export interface JupyterActiveKernel {
  readonly metadata?: unknown;
  readonly uri: vscode.Uri;
  readonly id: string;
}

export interface JupyterKernelService {
  readonly getActiveKernels?: () => Promise<readonly JupyterActiveKernel[]>;
  readonly getKernel?: (uri: vscode.Uri) => Promise<JupyterApiKernel | undefined>;
}

export interface JupyterExports {
  readonly ready?: Promise<void>;
  readonly getKernelService?: () => Promise<JupyterKernelService | undefined>;
}

export async function activateJupyter(): Promise<JupyterExports | undefined> {
  const extension = vscode.extensions.getExtension<JupyterExports>('ms-toolsai.jupyter');
  if (!extension) {
    return undefined;
  }
  try {
    await extension.activate();
  } catch (error) {
    return undefined;
  }
  return extension.exports;
}

export async function getJupyterKernelService(): Promise<JupyterKernelService | undefined> {
  const exports = await activateJupyter();
  if (!exports?.getKernelService) {
    return undefined;
  }
  try {
    return await exports.getKernelService();
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readColabServerHandle(metadata: unknown): string | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const handle = metadata.serverProviderHandle;
  if (!isRecord(handle)) {
    return null;
  }
  if (handle.extensionId !== 'google.colab' || handle.id !== 'colab') {
    return null;
  }
  return typeof handle.handle === 'string' ? handle.handle : null;
}

export async function findColabKernel(
  service: JupyterKernelService,
  serverId: string,
): Promise<JupyterApiKernel | undefined> {
  if (!service.getActiveKernels || !service.getKernel) {
    return undefined;
  }
  const kernels = await service.getActiveKernels();
  const match = kernels.find((kernel) => readColabServerHandle(kernel.metadata) === serverId);
  if (!match) {
    return undefined;
  }
  return service.getKernel(match.uri);
}
