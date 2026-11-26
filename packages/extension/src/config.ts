import * as vscode from 'vscode';
import type { IdleGuardSettings, TimeRange } from '@colabdeck/shared';
import type { LogLevel } from './log.js';

export interface ColabDeckConfig {
  readonly sampleIntervalMs: number;
  readonly probeDir: string;
  readonly idleGuard: IdleGuardSettings;
  readonly timeRange: TimeRange;
  readonly showProcesses: boolean;
  readonly logLevel: LogLevel;
}

function number(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = configuration.get<number>(key, fallback);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, raw));
}

function boolean(configuration: vscode.WorkspaceConfiguration, key: string, fallback: boolean): boolean {
  return configuration.get<boolean>(key, fallback);
}

function enumeration<T extends string>(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const raw = configuration.get<string>(key, fallback);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

export function readConfig(): ColabDeckConfig {
  const probe = vscode.workspace.getConfiguration('colabdeck.probe');
  const idle = vscode.workspace.getConfiguration('colabdeck.idleGuard');
  const dashboard = vscode.workspace.getConfiguration('colabdeck.dashboard');
  const logging = vscode.workspace.getConfiguration('colabdeck.logging');
  const idleThresholdMinutes = number(idle, 'idleThresholdMinutes', 5, 1, 120);
  const countdownSeconds = number(idle, 'countdownSeconds', 120, 10, 3600);
  const staleSampleSeconds = number(idle, 'staleSampleSeconds', 15, 5, 300);
  const minRuntimeMinutes = number(idle, 'minRuntimeMinutes', 5, 0, 120);
  const snoozeMinutes = number(idle, 'snoozeMinutes', 30, 1, 720);
  const idleGuard: IdleGuardSettings = {
    enabled: boolean(idle, 'enabled', true),
    gpuUtilizationThresholdPct: number(idle, 'gpuUtilizationThresholdPct', 5, 0, 100),
    idleDebounceMs: number(idle, 'idleDebounceMs', 5000, 1000, 600_000),
    idleThresholdMs: idleThresholdMinutes * 60_000,
    countdownMs: countdownSeconds * 1000,
    staleSampleMs: staleSampleSeconds * 1000,
    minRuntimeMs: minRuntimeMinutes * 60_000,
    snoozeMs: snoozeMinutes * 60_000,
    autoRelease: boolean(idle, 'autoRelease', true),
    requireKernelIdle: enumeration(idle, 'requireKernelIdle', 'auto', ['auto', 'always', 'never'] as const),
  };
  return {
    sampleIntervalMs: number(probe, 'sampleIntervalMs', 5000, 1000, 60_000),
    probeDir: probe.get<string>('probeDir', '/content/.colabdeck').trim(),
    idleGuard,
    timeRange: enumeration(dashboard, 'timeRange', '30m', ['15m', '30m', '1h'] as const),
    showProcesses: boolean(dashboard, 'showProcesses', true),
    logLevel: enumeration(logging, 'level', 'info', [
      'off',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ] as const),
  };
}

export function toDashboardSettings(config: ColabDeckConfig): import('@colabdeck/shared').DashboardSettings {
  return {
    timeRange: config.timeRange,
    showProcesses: config.showProcesses,
    idleGuard: {
      enabled: config.idleGuard.enabled,
      thresholdPct: config.idleGuard.gpuUtilizationThresholdPct,
      idleThresholdMinutes: config.idleGuard.idleThresholdMs / 60_000,
      countdownSeconds: config.idleGuard.countdownMs / 1000,
      snoozeMinutes: config.idleGuard.snoozeMs / 60_000,
      autoRelease: config.idleGuard.autoRelease,
      requireKernelIdle: config.idleGuard.requireKernelIdle,
    },
    probe: {
      sampleIntervalMs: config.sampleIntervalMs,
    },
  };
}
