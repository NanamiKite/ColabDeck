import { z } from 'zod';
import type { CountdownPhase, IdleGuardStatus } from '../idleGuard/states.js';

export const WEBVIEW_PROTOCOL_VERSION = 1 as const;

export type TimeRange = '15m' | '30m' | '1h';

export type ServerSource = 'kernel-api' | 'mounted-folder' | 'persisted';

export interface ServerDescriptor {
  readonly id: string;
  readonly label: string;
  readonly source: ServerSource;
  readonly notebookUri: string | null;
  /** 仅用于日志与诊断；绝不能发送到 Webview。 */
  readonly jupyterBaseUrl: string | null;
  readonly kernelApiAvailable: boolean;
}

export interface ServerView {
  readonly id: string;
  readonly label: string;
  readonly source: ServerSource;
  readonly notebookUri: string | null;
}

export type ProbeConnectionState = 'disconnected' | 'syncing' | 'connected' | 'stale' | 'error';

export type ProbeStatusView = 'starting' | 'running' | 'stale' | 'stopped' | 'error';

export interface ProbeView {
  readonly pid: number;
  readonly bootId: string;
  readonly startedAtMs: number;
  readonly lastSampleAtMs: number;
  readonly lastReceivedAtMs: number;
  readonly sampleIntervalMs: number;
  readonly status: ProbeStatusView;
}

export interface GpuSample {
  readonly index: number;
  readonly name: string;
  readonly utilizationPct: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly temperatureC: number | null;
  readonly powerWatts: number | null;
}

export interface GpuAggregate {
  readonly count: number;
  readonly shortName: string;
  readonly utilizationPct: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly temperatureC: number | null;
  readonly powerWatts: number | null;
}

export interface RamSample {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
}

export interface DiskSample {
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
}

export interface CpuSample {
  readonly count: number;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
}

export interface TemperatureSample {
  readonly cpuC: number | null;
  readonly gpuC: number | null;
}

export interface TelemetrySample {
  readonly seq: number;
  readonly timestampMs: number;
  readonly receivedAtMs: number;
  readonly gpus: readonly GpuSample[];
  readonly gpuAggregate: GpuAggregate | null;
  readonly ram: RamSample;
  readonly disk: DiskSample;
  readonly cpu: CpuSample;
  readonly temperature: TemperatureSample;
  readonly errors: readonly string[];
}

export interface IdleGuardView {
  readonly status: IdleGuardStatus;
  readonly enabled: boolean;
  readonly thresholdPct: number;
  readonly idleForMs: number;
  readonly idleThresholdMs: number;
  readonly snoozedUntilMs: number | null;
  readonly lastTransitionAtMs: number;
  readonly reason: string | null;
  readonly kernelBusy: boolean | null;
}

export interface CountdownView {
  readonly endsAtMs: number;
  readonly remainingMs: number;
  readonly autoRelease: boolean;
  readonly phase: CountdownPhase;
}

export interface IdleGuardTransitionView {
  readonly atMs: number;
  readonly from: IdleGuardStatus;
  readonly to: IdleGuardStatus;
  readonly event: string;
  readonly reason: string;
}

export type UiErrorAction = 'RETRY' | 'OPEN_SETTINGS' | 'OPEN_PROBE_LOG' | 'NONE';

export interface UiError {
  readonly id: string;
  readonly message: string;
  readonly detail: string | null;
  readonly recoverable: boolean;
  readonly action: UiErrorAction;
}

export interface DashboardSettings {
  readonly timeRange: TimeRange;
  readonly idleGuard: {
    readonly enabled: boolean;
    readonly thresholdPct: number;
    readonly idleThresholdMinutes: number;
    readonly countdownSeconds: number;
    readonly snoozeMinutes: number;
    readonly autoRelease: boolean;
    readonly requireKernelIdle: 'auto' | 'always' | 'never';
  };
  readonly probe: {
    readonly sampleIntervalMs: number;
    readonly launchMethod: 'auto' | 'kernel' | 'terminal';
  };
}

export interface DashboardSnapshot {
  readonly protocol: 1;
  readonly generatedAtMs: number;
  readonly servers: readonly ServerView[];
  readonly selectedServerId: string | null;
  readonly connection: ProbeConnectionState;
  readonly probe: ProbeView | null;
  readonly latest: TelemetrySample | null;
  readonly idleGuard: IdleGuardView;
  readonly countdown: CountdownView | null;
  readonly errors: readonly UiError[];
  readonly settings: DashboardSettings;
}

export type WebviewToHostMessage =
  | { readonly type: 'READY'; readonly protocol: number }
  | {
      readonly type: 'REQUEST_SNAPSHOT';
      readonly requestId: string;
      readonly range: TimeRange;
    }
  | { readonly type: 'SELECT_SERVER'; readonly serverId: string }
  | {
      readonly type: 'IDLE_GUARD_CANCEL';
      readonly requestId: string;
      readonly source: 'webview';
    }
  | {
      readonly type: 'IDLE_GUARD_SNOOZE';
      readonly requestId: string;
      readonly durationMs: number;
      readonly source: 'webview';
    }
  | {
      readonly type: 'IDLE_GUARD_RELEASE_NOW';
      readonly requestId: string;
      readonly source: 'webview';
    }
  | { readonly type: 'IDLE_GUARD_SET_ENABLED'; readonly enabled: boolean }
  | { readonly type: 'REFRESH_GPU_PROCESSES'; readonly requestId: string }
  | { readonly type: 'KILL_PROCESS'; readonly requestId: string; readonly pid: number }
  | { readonly type: 'CLEAR_CUDA_CACHE'; readonly requestId: string }
  | {
      readonly type: 'SCAN_DISK';
      readonly requestId: string;
      readonly path: string;
      readonly maxEntries: number;
      readonly maxDepth: number;
    }
  | { readonly type: 'DISMISS_ERROR'; readonly errorId: string }
  | { readonly type: 'MOUNT_COLAB_SERVER' }
  | { readonly type: 'RELOAD_WINDOW' }
  | { readonly type: 'OPEN_SETTINGS' }
  | { readonly type: 'OPEN_PROBE_LOG' }
  | { readonly type: 'RETRY_PROBE' };

export interface GpuProcessView {
  readonly pid: number;
  readonly name: string;
  readonly command: string | null;
  readonly usedMemoryBytes: number | null;
  readonly gpuUuid: string | null;
}

export type ToolboxResult =
  | {
      readonly kind: 'KILL_PROCESS';
      readonly ok: boolean;
      readonly pid: number;
      readonly alreadyDead: boolean;
      readonly verified: boolean;
      readonly message: string | null;
    }
  | {
      readonly kind: 'SCAN_DISK';
      readonly ok: boolean;
      readonly path: string;
      readonly entries: readonly { readonly path: string; readonly bytes: number; readonly kind: 'file' | 'directory' }[];
      readonly truncated: boolean;
      readonly message: string | null;
    }
  | {
      readonly kind: 'CLEAR_CUDA_CACHE';
      readonly ok: boolean;
      readonly message: string;
    }
  | {
      readonly kind: 'REFRESH_PROCESSES';
      readonly ok: boolean;
      readonly message: string | null;
    };

export type HostToWebviewMessage =
  | {
      readonly type: 'PROTOCOL_MISMATCH';
      readonly hostProtocol: 1;
      readonly webviewProtocol: number;
    }
  | { readonly type: 'SNAPSHOT'; readonly snapshot: DashboardSnapshot }
  | {
      readonly type: 'TELEMETRY_BATCH';
      readonly range: TimeRange;
      readonly samples: readonly TelemetrySample[];
    }
  | { readonly type: 'TELEMETRY_APPEND'; readonly sample: TelemetrySample }
  | {
      readonly type: 'IDLE_GUARD_STATE';
      readonly state: IdleGuardView;
      readonly countdown: CountdownView | null;
      readonly recentTransitions: readonly IdleGuardTransitionView[];
    }
  | {
      readonly type: 'GPU_PROCESSES';
      readonly processes: readonly GpuProcessView[];
      readonly source: 'nvidia-smi' | 'procfs' | 'none';
      readonly fetchedAtMs: number;
      readonly warning: string | null;
    }
  | {
      readonly type: 'TOOLBOX_RESULT';
      readonly requestId: string;
      readonly result: ToolboxResult;
    }
  | {
      readonly type: 'ERROR';
      readonly errorId: string;
      readonly message: string;
      readonly detail: string | null;
      readonly recoverable: boolean;
      readonly action: UiErrorAction;
    }
  | { readonly type: 'SETTINGS_CHANGED'; readonly settings: DashboardSettings };

const requestIdSchema = z.string().min(1).max(128);
const serverIdSchema = z.string().min(1).max(512);
const sourceSchema = z.literal('webview');
const rangeSchema = z.enum(['15m', '30m', '1h']);

export const webviewToHostMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('READY'), protocol: z.number().int().positive() }).strict(),
  z
    .object({
      type: z.literal('REQUEST_SNAPSHOT'),
      requestId: requestIdSchema,
      range: rangeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('SELECT_SERVER'),
      serverId: serverIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('IDLE_GUARD_CANCEL'),
      requestId: requestIdSchema,
      source: sourceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('IDLE_GUARD_SNOOZE'),
      requestId: requestIdSchema,
      durationMs: z.number().int().positive().max(86_400_000),
      source: sourceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('IDLE_GUARD_RELEASE_NOW'),
      requestId: requestIdSchema,
      source: sourceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('IDLE_GUARD_SET_ENABLED'),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('REFRESH_GPU_PROCESSES'),
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('KILL_PROCESS'),
      requestId: requestIdSchema,
      pid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('CLEAR_CUDA_CACHE'),
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('SCAN_DISK'),
      requestId: requestIdSchema,
      path: z.string().min(1).max(4096),
      maxEntries: z.number().int().min(1).max(1000),
      maxDepth: z.number().int().min(0).max(16),
    })
    .strict(),
  z
    .object({
      type: z.literal('DISMISS_ERROR'),
      errorId: z.string().min(1).max(128),
    })
    .strict(),
  z.object({ type: z.literal('MOUNT_COLAB_SERVER') }).strict(),
  z.object({ type: z.literal('RELOAD_WINDOW') }).strict(),
  z.object({ type: z.literal('OPEN_SETTINGS') }).strict(),
  z.object({ type: z.literal('OPEN_PROBE_LOG') }).strict(),
  z.object({ type: z.literal('RETRY_PROBE') }).strict(),
]);
