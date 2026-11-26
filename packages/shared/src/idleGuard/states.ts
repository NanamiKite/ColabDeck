export type IdleGuardStatus =
  | 'DISABLED'
  | 'DISCONNECTED'
  | 'SYNCING'
  | 'ACTIVE'
  | 'IDLE_DETECTED'
  | 'COUNTDOWN_WARNING'
  | 'TERMINATING'
  | 'TERMINATED'
  | 'ERROR'
  | 'UNSUPPORTED';

export type CountdownPhase = 'warning' | 'expired' | 'kernel-busy' | 'terminating';
