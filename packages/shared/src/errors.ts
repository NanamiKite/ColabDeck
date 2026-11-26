export type ColabDeckErrorCode =
  | 'JUPYTER_API_ACCESS_DENIED'
  | 'WORKSPACE_NOT_TRUSTED'
  | 'NO_ACTIVE_COLAB_KERNEL'
  | 'SERVER_ID_UNAVAILABLE'
  | 'SERVER_UNAUTHORIZED'
  | 'SERVER_UNAVAILABLE'
  | 'PROBE_WRITE_FAILED'
  | 'PROBE_LAUNCH_FAILED'
  | 'PROBE_STALE'
  | 'PROBE_PROTOCOL_MISMATCH'
  | 'PROBE_COMMAND_TIMEOUT'
  | 'PROBE_COMMAND_REJECTED'
  | 'RELEASE_COMMAND_UNAVAILABLE'
  | 'RELEASE_FAILED'
  | 'RELEASE_INTERACTIVE_ONLY'
  | 'CUDA_CACHE_KERNEL_BUSY'
  | 'CUDA_CACHE_KERNEL_UNAVAILABLE'
  | 'DISK_SCAN_FAILED'
  | 'KILL_REJECTED'
  | 'UNKNOWN';

export type ColabDeckErrorAction = 'RETRY' | 'OPEN_SETTINGS' | 'OPEN_PROBE_LOG' | 'NONE';

export interface ColabDeckErrorOptions {
  readonly code?: ColabDeckErrorCode;
  readonly detail?: string | null;
  readonly recoverable?: boolean;
  readonly action?: ColabDeckErrorAction;
  readonly cause?: unknown;
}

export class ColabDeckError extends Error {
  readonly code: ColabDeckErrorCode;
  readonly detail: string | null;
  readonly recoverable: boolean;
  readonly action: ColabDeckErrorAction;
  override readonly cause: unknown;

  constructor(message: string, options: ColabDeckErrorOptions = {}) {
    super(message);
    this.name = 'ColabDeckError';
    this.code = options.code ?? 'UNKNOWN';
    this.detail = options.detail ?? null;
    this.recoverable = options.recoverable ?? true;
    this.action = options.action ?? 'NONE';
    this.cause = options.cause;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
