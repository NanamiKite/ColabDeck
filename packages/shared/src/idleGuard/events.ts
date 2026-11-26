import type { TelemetrySample } from '../protocol/webview.js';

export type IdleGuardSource = 'webview' | 'notification' | 'command';

export type IdleGuardEvent =
  | { readonly type: 'SETTINGS_ENABLED' }
  | { readonly type: 'SETTINGS_DISABLED' }
  | { readonly type: 'SETTINGS_CHANGED' }
  | {
      readonly type: 'SERVER_CONNECTED';
      readonly serverId: string;
      readonly serverLabel: string;
      readonly gpuPresent: boolean;
      readonly connectedAtMs: number;
    }
  | { readonly type: 'SERVER_DISCONNECTED'; readonly reason: string }
  | { readonly type: 'PROBE_STARTED' }
  | { readonly type: 'PROBE_LOST'; readonly reason: string }
  | { readonly type: 'PROBE_ERROR'; readonly message: string }
  | {
      readonly type: 'SAMPLE_RECEIVED';
      readonly sample: TelemetrySample;
      readonly sampleAgeMs: number;
      readonly kernelBusy: boolean | null;
    }
  | { readonly type: 'IDLE_THRESHOLD_REACHED' }
  | { readonly type: 'COUNTDOWN_TICK'; readonly remainingMs: number }
  | { readonly type: 'COUNTDOWN_EXPIRED' }
  | { readonly type: 'CANCEL'; readonly source: IdleGuardSource }
  | {
      readonly type: 'SNOOZE';
      readonly durationMs: number;
      readonly source: IdleGuardSource;
    }
  | { readonly type: 'RELEASE_NOW'; readonly source: IdleGuardSource }
  | { readonly type: 'RELEASE_SUCCEEDED' }
  | { readonly type: 'RELEASE_FAILED'; readonly message: string }
  | { readonly type: 'RELEASE_CANCELLED'; readonly reason: string }
  | { readonly type: 'RETRY' };
