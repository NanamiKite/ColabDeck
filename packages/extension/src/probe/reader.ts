import * as vscode from 'vscode';
import { ColabDeckError, probeSampleSchema, probeStatusSchema } from '@colabdeck/shared';
import type { ProbeSample, ProbeStatus } from '@colabdeck/shared';
import type { Logger } from '../log.js';
import { colabUri, type ProbePaths } from './probePaths.js';
import { probeFileRemotePath, validateMetricsFileName } from './probePathUtils.js';

export interface ProbeReadResult {
  readonly status: ProbeStatus;
  readonly samples: readonly ProbeSample[];
  readonly reset: boolean;
}

export class ProbeReader {
  private offset = 0;
  private partial = '';
  private bootId: string | null = null;
  private metricsFile: string | null = null;
  private lastSize = 0;
  private lastSeq = 0;
  private decoder = new TextDecoder();

  constructor(
    private readonly paths: ProbePaths,
    private readonly logger: Logger,
  ) {}

  async readStatus(): Promise<ProbeStatus> {
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(this.paths.status);
    } catch (error) {
      throw new ColabDeckError('Monitoring status is unavailable.', {
        code: 'PROBE_STALE',
        detail: error instanceof vscode.FileSystemError ? error.code : error instanceof Error ? error.message : String(error),
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(this.decoder.decode(raw));
    } catch (error) {
      throw new ColabDeckError('Monitoring status is invalid.', {
        code: 'PROBE_PROTOCOL_MISMATCH',
        detail: 'Restart monitoring, then retry.',
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    const parsed = probeStatusSchema.safeParse(json);
    if (!parsed.success) {
      throw new ColabDeckError('Monitoring status is incompatible.', {
        code: 'PROBE_PROTOCOL_MISMATCH',
        detail: parsed.error.message,
        recoverable: true,
        action: 'RETRY',
      });
    }
    return parsed.data;
  }

  async read(): Promise<ProbeReadResult> {
    const status = await this.readStatus();
    let reset = false;
    if (this.bootId !== null && this.bootId !== status.bootId) {
      this.logger.info(`[ProbeReader] probe bootId changed (${this.bootId.slice(0, 8)} -> ${status.bootId.slice(0, 8)}); resetting`);
      reset = true;
    }
    if (this.metricsFile !== null && this.metricsFile !== status.metricsFile) {
      this.logger.info(`[ProbeReader] metrics file changed (${this.metricsFile} -> ${status.metricsFile}); resetting`);
      reset = true;
    }
    if (reset) {
      this.resetStream();
    }
    this.bootId = status.bootId;
    this.metricsFile = status.metricsFile;

    const metricsError = validateMetricsFileName(status.metricsFile);
    if (metricsError) {
      throw new ColabDeckError(metricsError, {
        code: 'PROBE_PROTOCOL_MISMATCH',
        recoverable: true,
        action: 'RETRY',
      });
    }
    const metricsUri = colabUri(this.paths.serverId, probeFileRemotePath(this.paths.relativeDir, status.metricsFile));
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(metricsUri);
    } catch (error) {
      throw new ColabDeckError('Monitoring data is unavailable.', {
        code: 'PROBE_STALE',
        detail: error instanceof vscode.FileSystemError ? error.code : error instanceof Error ? error.message : String(error),
        recoverable: true,
        action: 'RETRY',
        cause: error,
      });
    }
    if (bytes.byteLength < this.lastSize) {
      this.logger.info('[ProbeReader] metrics file rotated or shrank; resetting stream offset');
      this.resetStream();
      reset = true;
    }
    this.lastSize = bytes.byteLength;
    if (this.offset > bytes.byteLength) {
      this.offset = 0;
      this.partial = '';
    }
    const newText = this.decoder.decode(bytes.subarray(this.offset));
    this.offset = bytes.byteLength;
    const combined = this.partial + newText;
    const lines = combined.split('\n');
    this.partial = lines.pop() ?? '';
    const samples: ProbeSample[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = probeSampleSchema.safeParse(JSON.parse(line));
        if (parsed.success && parsed.data.bootId === status.bootId && parsed.data.seq > this.lastSeq) {
          samples.push(parsed.data);
          this.lastSeq = parsed.data.seq;
        }
      } catch {
        this.logger.debug('[ProbeReader] ignoring a malformed metrics line');
      }
    }
    samples.sort((left, right) => left.seq - right.seq);
    return { status, samples, reset };
  }

  private resetStream(): void {
    this.offset = 0;
    this.partial = '';
    this.lastSeq = 0;
    this.lastSize = 0;
  }
}
