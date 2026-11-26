import * as vscode from 'vscode';
import { normalizeProbeDir, probeFileRemotePath } from './probePathUtils.js';

export interface ProbePaths {
  readonly serverId: string;
  readonly dir: string;
  readonly relativeDir: string;
  readonly root: vscode.Uri;
  readonly script: vscode.Uri;
  readonly status: vscode.Uri;
  readonly metrics: vscode.Uri;
  readonly commands: vscode.Uri;
  readonly results: vscode.Uri;
  readonly log: vscode.Uri;
}

export function buildProbePaths(serverId: string, probeDir: string): ProbePaths {
  const normalized = normalizeProbeDir(probeDir);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  const root = colabUri(serverId, probeFileRemotePath(normalized.relativeDir, ''));
  return {
    serverId,
    dir: normalized.dir,
    relativeDir: normalized.relativeDir,
    root,
    script: colabUri(serverId, probeFileRemotePath(normalized.relativeDir, 'colabdeck_probe.py')),
    status: colabUri(serverId, probeFileRemotePath(normalized.relativeDir, 'status.json')),
    metrics: colabUri(serverId, probeFileRemotePath(normalized.relativeDir, 'metrics.jsonl')),
    commands: colabUri(serverId, probeFileRemotePath(normalized.relativeDir, 'commands')),
    results: colabUri(serverId, probeFileRemotePath(normalized.relativeDir, 'results')),
    log: colabUri(serverId, probeFileRemotePath(normalized.relativeDir, 'probe.log')),
  };
}

export function colabUri(serverId: string, remotePath: string): vscode.Uri {
  const normalizedPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
  return vscode.Uri.from({ scheme: 'colab', authority: serverId, path: normalizedPath });
}

export function buildCommandFileUri(serverId: string, relativeDir: string, requestId: string): vscode.Uri {
  return colabUri(serverId, probeFileRemotePath(relativeDir, `commands/${requestId}.json`));
}

export function buildCommandTempFileUri(serverId: string, relativeDir: string, requestId: string): vscode.Uri {
  return colabUri(serverId, probeFileRemotePath(relativeDir, `commands/${requestId}.json.tmp`));
}

export function buildResultFileUri(serverId: string, relativeDir: string, requestId: string): vscode.Uri {
  return colabUri(serverId, probeFileRemotePath(relativeDir, `results/${requestId}.json`));
}
