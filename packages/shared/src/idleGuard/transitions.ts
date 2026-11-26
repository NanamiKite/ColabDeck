import type { IdleGuardEvent } from './events.js';
import type { IdleGuardStatus } from './states.js';

export interface IdleGuardTransition {
  readonly atMs: number;
  readonly from: IdleGuardStatus;
  readonly to: IdleGuardStatus;
  readonly event: IdleGuardEvent['type'];
  readonly reason: string;
  readonly serverId: string | null;
  readonly gpuUtilizationPct: number | null;
  readonly thresholdPct: number;
  readonly idleForMs: number;
  readonly countdownRemainingMs: number | null;
  readonly sampleAgeMs: number | null;
  readonly kernelBusy: boolean | null;
}
