import * as vscode from 'vscode';
import { ColabDeckError } from '@colabdeck/shared';
import type {
  ColabDeckErrorCode,
  CountdownView,
  IdleGuardView,
  ServerDescriptor,
  TelemetrySample,
} from '@colabdeck/shared';
import type { IdleGuardEffect } from '@colabdeck/shared';
import { buildCountdown, buildIdleGuardView, buildRecentTransitions } from '@colabdeck/shared';
import {
  createInitialIdleGuardState,
  reduceIdleGuard,
  type IdleGuardSettings,
  type IdleGuardState,
} from '@colabdeck/shared';
import type { CountdownAction } from '@colabdeck/shared';
import type { IdleGuardEvent, IdleGuardSource } from '@colabdeck/shared';
import type { IdleGuardTransitionView } from '@colabdeck/shared';
import { abbreviateId } from '@colabdeck/shared';
import type { Logger } from '../log.js';

export interface IdleGuardSnapshot {
  readonly state: IdleGuardView;
  readonly countdown: CountdownView | null;
  readonly recentTransitions: readonly IdleGuardTransitionView[];
}

export interface IdleGuardDeps {
  readonly executeRelease: (server: ServerDescriptor) => Promise<void>;
  readonly verifyRelease: (server: ServerDescriptor) => Promise<boolean>;
  readonly getKernelBusy: (serverId: string) => Promise<boolean | null>;
  readonly showCountdownNotification: (
    message: string,
    actions: readonly CountdownAction[],
  ) => Promise<CountdownAction | undefined>;
  readonly showReleaseGuidance: (server: ServerDescriptor, message: string) => Promise<void>;
  readonly showError: (code: string, message: string) => Promise<void>;
  readonly showInfo: (message: string) => Promise<void>;
}

export class IdleGuardService implements vscode.Disposable {
  private state: IdleGuardState = createInitialIdleGuardState();
  private currentServer: ServerDescriptor | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private countdownInterval: NodeJS.Timeout | null = null;
  private countdownTimeout: NodeJS.Timeout | null = null;
  private releaseInFlight = false;
  private readonly emitter = new vscode.EventEmitter<IdleGuardSnapshot>();
  private readonly errorEmitter = new vscode.EventEmitter<ColabDeckError>();
  readonly onChange = this.emitter.event;
  readonly onError = this.errorEmitter.event;

  constructor(
    private readonly logger: Logger,
    private settings: IdleGuardSettings,
    private readonly deps: IdleGuardDeps,
  ) {
    if (settings.enabled) {
      this.dispatch({ type: 'SETTINGS_ENABLED' });
    }
  }

  get snapshot(): IdleGuardSnapshot {
    const now = Date.now();
    return {
      state: buildIdleGuardView(this.state, this.settings, now),
      countdown: buildCountdown(this.state, this.settings, now),
      recentTransitions: buildRecentTransitions(this.state.transitions),
    };
  }

  get status(): IdleGuardView['status'] {
    return this.state.status;
  }

  get serverId(): string | null {
    return this.currentServer?.id ?? null;
  }

  get settingsValue(): IdleGuardSettings {
    return this.settings;
  }

  updateSettings(settings: IdleGuardSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = settings;
    if (!settings.enabled && wasEnabled) {
      this.dispatch({ type: 'SETTINGS_DISABLED' });
      return;
    }
    if (settings.enabled && !wasEnabled) {
      this.dispatch({ type: 'SETTINGS_ENABLED' });
      if (this.currentServer) {
        this.dispatch({
          type: 'SERVER_CONNECTED',
          serverId: this.currentServer.id,
          serverLabel: this.currentServer.label,
          gpuPresent: true,
          connectedAtMs: Date.now(),
        });
      }
      return;
    }
    this.dispatch({ type: 'SETTINGS_CHANGED' });
  }

  handleServerConnected(server: ServerDescriptor): void {
    this.currentServer = server;
    if (!this.settings.enabled) {
      return;
    }
    this.dispatch({
      type: 'SERVER_CONNECTED',
      serverId: server.id,
      serverLabel: server.label,
      gpuPresent: true,
      connectedAtMs: Date.now(),
    });
  }

  handleServerDisconnected(serverId: string, reason: string): void {
    if (this.currentServer && this.currentServer.id !== serverId) {
      return;
    }
    if (this.currentServer?.id === serverId) {
      this.currentServer = null;
    }
    this.dispatch({ type: 'SERVER_DISCONNECTED', reason });
  }

  handleProbeLost(serverId: string, reason: string): void {
    if (this.currentServer && this.currentServer.id !== serverId) {
      return;
    }
    this.dispatch({ type: 'PROBE_LOST', reason });
  }

  async onSample(server: ServerDescriptor, sample: TelemetrySample): Promise<void> {
    this.currentServer = server;
    let kernelBusy: boolean | null = null;
    if (
      this.settings.requireKernelIdle !== 'never' &&
      (this.state.status === 'IDLE_DETECTED' || this.state.status === 'COUNTDOWN_WARNING')
    ) {
      try {
        kernelBusy = await Promise.race([
          this.deps.getKernelBusy(server.id),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]);
      } catch (error) {
        this.logger.debug('[IdleGuard] kernel status unavailable', error);
      }
    }
    this.dispatch({
      type: 'SAMPLE_RECEIVED',
      sample,
      sampleAgeMs: Math.max(0, Date.now() - sample.receivedAtMs),
      kernelBusy,
    });
  }

  cancel(source: IdleGuardSource = 'command'): void {
    this.dispatch({ type: 'CANCEL', source });
  }

  snooze(durationMs = this.settings.snoozeMs, source: IdleGuardSource = 'command'): void {
    this.dispatch({ type: 'SNOOZE', durationMs, source });
  }

  releaseNow(source: IdleGuardSource = 'command'): void {
    this.dispatch({ type: 'RELEASE_NOW', source });
  }

  dispose(): void {
    this.clearTimers();
    this.emitter.dispose();
    this.errorEmitter.dispose();
  }

  private dispatch(event: IdleGuardEvent): void {
    const now = Date.now();
    const result = reduceIdleGuard(this.state, event, this.settings, now);
    this.state = result.state;
    for (const effect of result.effects) {
      this.applyEffect(effect);
    }
  }

  private applyEffect(effect: IdleGuardEffect): void {
    switch (effect.type) {
      case 'LOG_TRANSITION': {
        const transition = effect.transition;
        this.logger.info(
          `[IdleGuard] ${transition.from} -> ${transition.to} event=${transition.event} reason="${transition.reason}"` +
            ` server=${abbreviateId(transition.serverId)} gpu=${transition.gpuUtilizationPct ?? 'null'}%` +
            ` threshold=${transition.thresholdPct}% idleForMs=${transition.idleForMs}` +
            ` countdownMs=${transition.countdownRemainingMs ?? 'null'} sampleAgeMs=${transition.sampleAgeMs ?? 'null'}` +
            ` kernelBusy=${String(transition.kernelBusy)}`,
        );
        return;
      }
      case 'PUBLISH_STATE': {
        this.emitter.fire({
          state: effect.state,
          countdown: effect.countdown,
          recentTransitions: buildRecentTransitions(this.state.transitions),
        });
        return;
      }
      case 'START_IDLE_TIMER': {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (effect.generation === this.state.generation) {
            this.dispatch({ type: 'IDLE_THRESHOLD_REACHED' });
          }
        }, Math.max(0, effect.delayMs));
        return;
      }
      case 'CANCEL_IDLE_TIMER':
      case 'RESET_IDLE_TIMER':
        this.clearIdleTimer();
        return;
      case 'START_COUNTDOWN': {
        this.clearCountdownTimers();
        const tick = (): void => {
          if (effect.generation === this.state.generation) {
            this.dispatch({
              type: 'COUNTDOWN_TICK',
              remainingMs: Math.max(0, (this.state.countdownEndsAtMs ?? Date.now()) - Date.now()),
            });
          }
        };
        this.countdownInterval = setInterval(tick, 1_000);
        this.countdownTimeout = setTimeout(() => {
          this.countdownTimeout = null;
          if (effect.generation === this.state.generation) {
            this.dispatch({ type: 'COUNTDOWN_EXPIRED' });
          }
        }, Math.max(0, effect.endsAtMs - Date.now()));
        return;
      }
      case 'CANCEL_COUNTDOWN':
        this.clearCountdownTimers();
        return;
      case 'SHOW_COUNTDOWN_NOTIFICATION': {
        void this.deps
          .showCountdownNotification(effect.message, effect.actions)
          .then((action) => {
            if (!action) {
              return;
            }
            if (action === 'CANCEL') {
              this.cancel('notification');
            } else if (action === 'SNOOZE') {
              this.snooze(this.settings.snoozeMs, 'notification');
            } else if (action === 'RELEASE_NOW') {
              this.releaseNow('notification');
            }
          })
          .catch((error) => this.logger.warn('[IdleGuard] notification failed', error));
        return;
      }
      case 'HIDE_COUNTDOWN_NOTIFICATION':
        return;
      case 'INVOKE_RELEASE':
        void this.invokeRelease(effect.serverId);
        return;
      case 'SHOW_RELEASE_GUIDANCE': {
        const server = this.currentServer;
        if (server) {
          void this.deps
            .showReleaseGuidance(server, effect.message)
            .catch((error) => this.logger.warn('[IdleGuard] guidance failed', error));
        }
        return;
      }
      case 'SHOW_ERROR': {
        const error = new ColabDeckError(effect.message, {
          code: effect.code as ColabDeckErrorCode,
          recoverable: effect.recoverable,
          action: 'RETRY',
        });
        this.errorEmitter.fire(error);
        void this.deps.showError(effect.code, effect.message).catch(() => undefined);
        return;
      }
      case 'SET_SNOOZE':
      case 'NONE':
        return;
    }
  }

  private async invokeRelease(serverId: string): Promise<void> {
    if (this.releaseInFlight) {
      return;
    }
    const server = this.currentServer;
    if (!server || server.id !== serverId) {
      this.dispatch({ type: 'RELEASE_FAILED', message: 'The selected server changed before release.' });
      return;
    }
    this.releaseInFlight = true;
    try {
      await this.deps.executeRelease(server);
      const released = await this.deps.verifyRelease(server);
      if (released) {
        this.dispatch({ type: 'RELEASE_SUCCEEDED' });
        await this.deps.showInfo(`Colab server "${server.label}" was released.`);
      } else {
        this.dispatch({
          type: 'RELEASE_CANCELLED',
          reason: 'the monitored server is still present after the release dialog closed',
        });
        await this.deps.showInfo(
          `Colab server "${server.label}" is still connected. Check the Colab dialog and try again if needed.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: 'RELEASE_FAILED', message });
    } finally {
      this.releaseInFlight = false;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearCountdownTimers(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.countdownTimeout) {
      clearTimeout(this.countdownTimeout);
      this.countdownTimeout = null;
    }
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    this.clearCountdownTimers();
  }
}
