/**
 * The Jupyter extension gates the Kernel API behind a publisher allow-list and shows an error
 * message on every denied call. Idle Guard runs on a timer and must never trigger that, so it may
 * only use a service that is already available (for example because the user explicitly ran the
 * CUDA cache action). Everything else may request access.
 */
export type KernelServiceAccess = 'idle-guard' | 'user';

export function canRequestKernelService(mode: KernelServiceAccess): boolean {
  return mode === 'user';
}
