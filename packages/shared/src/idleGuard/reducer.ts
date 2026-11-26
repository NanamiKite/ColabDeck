import type { CountdownPhase, IdleGuardStatus } from './states.js';
import type { IdleGuardEvent, IdleGuardSource } from './events.js';
import type { IdleGuardTransition } from './transitions.js';
import type {
  CountdownView,
  IdleGuardTransitionView,
  IdleGuardView,
  TelemetrySample,
} from '../protocol/webview.js';
import { formatDuration } from '../format.js';

export interface IdleGuardSettings {
  readonly enabled: boolean;
  readonly gpuUtilizationThresholdPct: number;
  readonly idleDebounceMs: number;
  readonly idleThresholdMs: number;
  readonly countdownMs: number;
  readonly staleSampleMs: number;
  readonly minRuntimeMs: number;
  readonly snoozeMs: number;
  readonly autoRelease: boolean;
  readonly requireKernelIdle: 'auto' | 'always' | 'never';
}

export interface IdleGuardState {
  readonly status: IdleGuardStatus;
  readonly serverId: string | null;
  readonly serverLabel: string | null;
  readonly gpuPresent: boolean | null;
  readonly connectedAtMs: number | null;
  readonly lastActivityAtMs: number | null;
  readonly idleSinceMs: number | null;
  readonly snoozedUntilMs: number | null;
  readonly countdownEndsAtMs: number | null;
  readonly lastSample: TelemetrySample | null;
  readonly lastSampleAgeMs: number | null;
  readonly kernelBusy: boolean | null;
  readonly lastTransitionAtMs: number;
  readonly reason: string | null;
  readonly generation: number;
  readonly phase: CountdownPhase | null;
  readonly transitions: readonly IdleGuardTransition[];
}

export type CountdownAction = 'CANCEL' | 'SNOOZE' | 'RELEASE_NOW';

export type IdleGuardEffect =
  | { readonly type: 'LOG_TRANSITION'; readonly transition: IdleGuardTransition }
  | {
      readonly type: 'PUBLISH_STATE';
      readonly state: IdleGuardView;
      readonly countdown: CountdownView | null;
    }
  | { readonly type: 'START_IDLE_TIMER'; readonly delayMs: number; readonly generation: number }
  | { readonly type: 'CANCEL_IDLE_TIMER' }
  | { readonly type: 'START_COUNTDOWN'; readonly endsAtMs: number; readonly generation: number }
  | { readonly type: 'CANCEL_COUNTDOWN' }
  | {
      readonly type: 'SHOW_COUNTDOWN_NOTIFICATION';
      readonly message: string;
      readonly actions: readonly CountdownAction[];
    }
  | { readonly type: 'HIDE_COUNTDOWN_NOTIFICATION' }
  | { readonly type: 'INVOKE_RELEASE'; readonly serverId: string }
  | { readonly type: 'SHOW_RELEASE_GUIDANCE'; readonly serverId: string; readonly message: string }
  | {
      readonly type: 'SHOW_ERROR';
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    }
  | { readonly type: 'RESET_IDLE_TIMER' }
  | { readonly type: 'SET_SNOOZE'; readonly untilMs: number }
  | { readonly type: 'NONE' };

export interface IdleGuardResult {
  readonly state: IdleGuardState;
  readonly effects: readonly IdleGuardEffect[];
}

type StatePatch = Partial<
  Omit<IdleGuardState, 'status' | 'transitions' | 'lastTransitionAtMs' | 'reason'>
>;

interface TransitionOutcome {
  readonly state: IdleGuardState;
  readonly transition: IdleGuardTransition;
}

export function createInitialIdleGuardState(): IdleGuardState {
  return {
    status: 'DISABLED',
    serverId: null,
    serverLabel: null,
    gpuPresent: null,
    connectedAtMs: null,
    lastActivityAtMs: null,
    idleSinceMs: null,
    snoozedUntilMs: null,
    countdownEndsAtMs: null,
    lastSample: null,
    lastSampleAgeMs: null,
    kernelBusy: null,
    lastTransitionAtMs: 0,
    reason: null,
    generation: 0,
    phase: null,
    transitions: [],
  };
}

const CANCEL_EFFECTS: readonly IdleGuardEffect[] = [
  { type: 'CANCEL_IDLE_TIMER' },
  { type: 'CANCEL_COUNTDOWN' },
  { type: 'HIDE_COUNTDOWN_NOTIFICATION' },
];

export function passesKernelGuard(
  settings: IdleGuardSettings,
  kernelBusy: boolean | null,
): boolean {
  if (!settings.autoRelease) {
    return false;
  }
  switch (settings.requireKernelIdle) {
    case 'never':
      return true;
    case 'always':
      return kernelBusy === false;
    case 'auto':
      return kernelBusy !== true;
  }
}

function computeIdleForMs(state: IdleGuardState, now: number): number {
  return state.idleSinceMs === null ? 0 : Math.max(0, now - state.idleSinceMs);
}

export function buildCountdown(
  state: IdleGuardState,
  settings: IdleGuardSettings,
  now: number,
): CountdownView | null {
  if (state.countdownEndsAtMs === null) {
    return null;
  }
  if (state.status !== 'COUNTDOWN_WARNING' && state.status !== 'TERMINATING') {
    return null;
  }
  const phase: CountdownPhase =
    state.status === 'TERMINATING' ? 'terminating' : (state.phase ?? 'warning');
  return {
    endsAtMs: state.countdownEndsAtMs,
    remainingMs: Math.max(0, state.countdownEndsAtMs - now),
    autoRelease: settings.autoRelease,
    phase,
  };
}

export function buildIdleGuardView(
  state: IdleGuardState,
  settings: IdleGuardSettings,
  now: number,
): IdleGuardView {
  const showIdle = state.status === 'IDLE_DETECTED' || state.status === 'COUNTDOWN_WARNING';
  return {
    status: state.status,
    enabled: settings.enabled,
    thresholdPct: settings.gpuUtilizationThresholdPct,
    idleForMs: showIdle ? computeIdleForMs(state, now) : 0,
    idleThresholdMs: settings.idleThresholdMs,
    snoozedUntilMs: state.snoozedUntilMs,
    lastTransitionAtMs: state.lastTransitionAtMs,
    reason: state.reason,
    kernelBusy: state.kernelBusy,
  };
}

export function buildRecentTransitions(
  transitions: readonly IdleGuardTransition[],
  limit = 10,
): readonly IdleGuardTransitionView[] {
  return transitions.slice(-limit).map((transition) => ({
    atMs: transition.atMs,
    from: transition.from,
    to: transition.to,
    event: transition.event,
    reason: transition.reason,
  }));
}

function publish(state: IdleGuardState, settings: IdleGuardSettings, now: number): IdleGuardEffect {
  return {
    type: 'PUBLISH_STATE',
    state: buildIdleGuardView(state, settings, now),
    countdown: buildCountdown(state, settings, now),
  };
}

function none(state: IdleGuardState): IdleGuardResult {
  return { state, effects: [] };
}

function move(
  state: IdleGuardState,
  to: IdleGuardStatus,
  event: IdleGuardEvent['type'],
  reason: string,
  settings: IdleGuardSettings,
  now: number,
  patch: StatePatch = {},
): TransitionOutcome {
  const idleForMs = computeIdleForMs(state, now);
  const countdownRemainingMs =
    state.countdownEndsAtMs === null ? null : Math.max(0, state.countdownEndsAtMs - now);
  const transition: IdleGuardTransition = {
    atMs: now,
    from: state.status,
    to,
    event,
    reason,
    serverId: state.serverId,
    gpuUtilizationPct: state.lastSample?.gpuAggregate?.utilizationPct ?? null,
    thresholdPct: settings.gpuUtilizationThresholdPct,
    idleForMs,
    countdownRemainingMs,
    sampleAgeMs: state.lastSampleAgeMs,
    kernelBusy: state.kernelBusy,
  };
  const phaseForTarget: CountdownPhase | null =
    to === 'COUNTDOWN_WARNING' ? (patch.phase ?? 'warning') : to === 'TERMINATING' ? 'terminating' : null;
  const nextState: IdleGuardState = {
    ...state,
    ...patch,
    status: to,
    phase: phaseForTarget,
    lastTransitionAtMs: now,
    reason,
    generation: state.generation + 1,
    transitions: [...state.transitions, transition].slice(-10),
  };
  return { state: nextState, transition };
}

function finishMove(
  outcome: TransitionOutcome,
  settings: IdleGuardSettings,
  now: number,
  extraEffects: readonly IdleGuardEffect[] = [],
): IdleGuardResult {
  return {
    state: outcome.state,
    effects: [
      { type: 'LOG_TRANSITION', transition: outcome.transition },
      ...extraEffects,
      publish(outcome.state, settings, now),
    ],
  };
}

function enterCountdown(
  state: IdleGuardState,
  event: IdleGuardEvent['type'],
  settings: IdleGuardSettings,
  now: number,
): IdleGuardResult {
  const outcome = move(
    state,
    'COUNTDOWN_WARNING',
    event,
    `GPU below ${settings.gpuUtilizationThresholdPct}% for ${Math.round(settings.idleThresholdMs / 60_000)}m`,
    settings,
    now,
    {
      phase: 'warning',
      countdownEndsAtMs: now + settings.countdownMs,
    },
  );
  const message = `Colab GPU looks idle. ${settings.autoRelease ? 'The Colab release dialog will open' : 'Release must be confirmed manually'} in ${formatDuration(settings.countdownMs)}.`;
  return {
    state: outcome.state,
    effects: [
      { type: 'LOG_TRANSITION', transition: outcome.transition },
      { type: 'CANCEL_IDLE_TIMER' },
      {
        type: 'START_COUNTDOWN',
        endsAtMs: now + settings.countdownMs,
        generation: outcome.state.generation,
      },
      {
        type: 'SHOW_COUNTDOWN_NOTIFICATION',
        message,
        actions: ['CANCEL', 'SNOOZE', 'RELEASE_NOW'],
      },
      publish(outcome.state, settings, now),
    ],
  };
}

function onSample(
  state: IdleGuardState,
  event: Extract<IdleGuardEvent, { readonly type: 'SAMPLE_RECEIVED' }>,
  settings: IdleGuardSettings,
  now: number,
): IdleGuardResult {
  if (state.status === 'DISABLED') {
    return none(state);
  }
  const sample = event.sample;
  const gpuPresent = sample.gpuAggregate !== null;
  const utilizationPct = sample.gpuAggregate?.utilizationPct ?? null;
  const fresh = event.sampleAgeMs <= settings.staleSampleMs;
  const base: IdleGuardState = {
    ...state,
    lastSample: sample,
    lastSampleAgeMs: event.sampleAgeMs,
    kernelBusy: event.kernelBusy,
    gpuPresent,
  };

  if (state.status === 'TERMINATING' || state.status === 'TERMINATED' || state.status === 'ERROR') {
    return { state: base, effects: [publish(base, settings, now)] };
  }
  if (state.status === 'DISCONNECTED') {
    return none(base);
  }
  if (!fresh) {
    const outcome = move(
      { ...base, idleSinceMs: null, snoozedUntilMs: null, countdownEndsAtMs: null, phase: null },
      'DISCONNECTED',
      event.type,
      `sample stale for ${event.sampleAgeMs}ms`,
      settings,
      now,
    );
    return finishMove(outcome, settings, now, CANCEL_EFFECTS);
  }
  if (state.status === 'SYNCING') {
    if (gpuPresent) {
      const outcome = move(
        { ...base, lastActivityAtMs: now, idleSinceMs: null, snoozedUntilMs: null },
        'ACTIVE',
        event.type,
        'first fresh GPU sample received',
        settings,
        now,
      );
      return finishMove(outcome, settings, now);
    }
    const outcome = move(base, 'UNSUPPORTED', event.type, 'runtime reports no GPU', settings, now);
    return finishMove(outcome, settings, now);
  }
  if (state.status === 'UNSUPPORTED') {
    if (!gpuPresent) {
      return { state: base, effects: [publish(base, settings, now)] };
    }
    const outcome = move(
      { ...base, lastActivityAtMs: now, idleSinceMs: null },
      'ACTIVE',
      event.type,
      'GPU became available',
      settings,
      now,
    );
    return finishMove(outcome, settings, now);
  }

  const threshold = settings.gpuUtilizationThresholdPct;
  if (state.status === 'ACTIVE') {
    if (utilizationPct !== null && utilizationPct >= threshold) {
      const nextState: IdleGuardState = { ...base, idleSinceMs: null, lastActivityAtMs: now, reason: null };
      return {
        state: nextState,
        effects: [publish(nextState, settings, now)],
      };
    }
    if (utilizationPct === null) {
      const nextState: IdleGuardState = {
        ...base,
        idleSinceMs: null,
        reason: 'GPU utilization unavailable; fail-safe keeps Idle Guard active',
      };
      return {
        state: nextState,
        effects: [publish(nextState, settings, now)],
      };
    }
    const runtimeAge = base.connectedAtMs === null ? Number.POSITIVE_INFINITY : now - base.connectedAtMs;
    const snoozed = base.snoozedUntilMs !== null && base.snoozedUntilMs > now;
    if (runtimeAge < settings.minRuntimeMs || snoozed) {
      const nextState: IdleGuardState = {
        ...base,
        idleSinceMs: null,
        reason: snoozed ? 'Idle Guard snoozed by user' : 'Runtime grace period',
      };
      return {
        state: nextState,
        effects: [publish(nextState, settings, now)],
      };
    }
    const idleSinceMs = base.idleSinceMs ?? now;
    const lowForMs = now - idleSinceMs;
    if (lowForMs >= settings.idleDebounceMs) {
      const outcome = move(
        { ...base, idleSinceMs },
        'IDLE_DETECTED',
        event.type,
        `GPU below ${threshold}% for ${lowForMs}ms`,
        settings,
        now,
      );
      return finishMove(outcome, settings, now, [
        {
          type: 'START_IDLE_TIMER',
          delayMs: Math.max(0, settings.idleThresholdMs - lowForMs),
          generation: outcome.state.generation,
        },
      ]);
    }
    return {
      state: { ...base, idleSinceMs, reason: 'GPU below threshold; debouncing' },
      effects: [publish({ ...base, idleSinceMs }, settings, now)],
    };
  }

  if (state.status === 'IDLE_DETECTED') {
    if (utilizationPct !== null && utilizationPct >= threshold) {
      const outcome = move(
        { ...base, idleSinceMs: null, snoozedUntilMs: null, countdownEndsAtMs: null },
        'ACTIVE',
        event.type,
        'GPU utilization recovered',
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    if (utilizationPct === null) {
      return { state: base, effects: [publish(base, settings, now)] };
    }
    const idleSinceMs = base.idleSinceMs ?? now;
    const lowForMs = now - idleSinceMs;
    if (lowForMs >= settings.idleThresholdMs) {
      return enterCountdown({ ...base, idleSinceMs }, event.type, settings, now);
    }
    return { state: { ...base, idleSinceMs }, effects: [publish({ ...base, idleSinceMs }, settings, now)] };
  }

  if (state.status === 'COUNTDOWN_WARNING') {
    if (utilizationPct !== null && utilizationPct >= threshold) {
      const outcome = move(
        { ...base, idleSinceMs: null, snoozedUntilMs: null, countdownEndsAtMs: null },
        'ACTIVE',
        event.type,
        'GPU utilization recovered during countdown',
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    return { state: base, effects: [publish(base, settings, now)] };
  }

  return { state: base, effects: [publish(base, settings, now)] };
}

export function reduceIdleGuard(
  state: IdleGuardState,
  event: IdleGuardEvent,
  settings: IdleGuardSettings,
  now: number,
): IdleGuardResult {
  switch (event.type) {
    case 'SETTINGS_ENABLED': {
      if (state.status !== 'DISABLED') {
        return none(state);
      }
      const outcome = move(state, 'DISCONNECTED', event.type, 'Idle Guard enabled', settings, now);
      return finishMove(outcome, settings, now);
    }
    case 'SETTINGS_DISABLED': {
      if (state.status === 'DISABLED') {
        return none(state);
      }
      const outcome = move(
        {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: null,
          countdownEndsAtMs: null,
          phase: null,
        },
        'DISABLED',
        event.type,
        'Idle Guard disabled',
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    case 'SETTINGS_CHANGED': {
      if (state.status === 'DISABLED') {
        return none(state);
      }
      if (
        state.status === 'COUNTDOWN_WARNING' &&
        (state.phase === 'expired' || state.phase === 'kernel-busy') &&
        passesKernelGuard(settings, state.kernelBusy)
      ) {
        const outcome = move(state, 'TERMINATING', event.type, 'settings now allow automatic release', settings, now, {
          phase: 'terminating',
        });
        return finishMove(outcome, settings, now, [
          { type: 'INVOKE_RELEASE', serverId: state.serverId ?? '' },
          {
            type: 'SHOW_RELEASE_GUIDANCE',
            serverId: state.serverId ?? '',
            message: 'ColabDeck opened the Colab release dialog. Confirm the server there.',
          },
          { type: 'CANCEL_COUNTDOWN' },
        ]);
      }
      return { state, effects: [publish(state, settings, now)] };
    }
    case 'SERVER_CONNECTED': {
      if (state.status === 'DISABLED') {
        return none(state);
      }
      const reset: IdleGuardState = {
        ...state,
        serverId: event.serverId,
        serverLabel: event.serverLabel,
        gpuPresent: event.gpuPresent,
        connectedAtMs: event.connectedAtMs,
        lastActivityAtMs: null,
        idleSinceMs: null,
        snoozedUntilMs: null,
        countdownEndsAtMs: null,
        lastSample: null,
        lastSampleAgeMs: null,
        kernelBusy: null,
        phase: null,
        transitions: [],
      };
      const outcome = move(reset, 'SYNCING', event.type, `server ${event.serverLabel} connected`, settings, now);
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    case 'SERVER_DISCONNECTED': {
      if (state.status === 'DISABLED' || state.status === 'TERMINATING') {
        return none(state);
      }
      const outcome = move(
        {
          ...state,
          serverId: null,
          serverLabel: null,
          idleSinceMs: null,
          snoozedUntilMs: null,
          countdownEndsAtMs: null,
          phase: null,
        },
        'DISCONNECTED',
        event.type,
        event.reason,
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    case 'PROBE_STARTED': {
      if (state.status === 'DISABLED' || state.status === 'TERMINATING' || state.status === 'TERMINATED') {
        return none(state);
      }
      if (state.status !== 'DISCONNECTED' && state.status !== 'ERROR') {
        return { state, effects: [publish(state, settings, now)] };
      }
      const outcome = move(state, 'SYNCING', event.type, 'probe started', settings, now, { phase: null });
      return finishMove(outcome, settings, now);
    }
    case 'SAMPLE_RECEIVED':
      return onSample(state, event, settings, now);
    case 'IDLE_THRESHOLD_REACHED': {
      if (state.status !== 'IDLE_DETECTED') {
        return none(state);
      }
      return enterCountdown(state, event.type, settings, now);
    }
    case 'COUNTDOWN_TICK': {
      if (state.status !== 'COUNTDOWN_WARNING' && state.status !== 'TERMINATING') {
        return none(state);
      }
      return { state, effects: [publish(state, settings, now)] };
    }
    case 'COUNTDOWN_EXPIRED': {
      if (state.status !== 'COUNTDOWN_WARNING') {
        return none(state);
      }
      if (passesKernelGuard(settings, state.kernelBusy)) {
        const outcome = move(
          state,
          'TERMINATING',
          event.type,
          'countdown expired; opening official Colab release dialog',
          settings,
          now,
          { phase: 'terminating' },
        );
        return finishMove(outcome, settings, now, [
          { type: 'INVOKE_RELEASE', serverId: state.serverId ?? '' },
          {
            type: 'SHOW_RELEASE_GUIDANCE',
            serverId: state.serverId ?? '',
            message: 'ColabDeck opened the Colab release dialog. Confirm the server there.',
          },
          { type: 'CANCEL_COUNTDOWN' },
        ]);
      }
      const phase: CountdownPhase = settings.autoRelease ? 'kernel-busy' : 'expired';
      const nextState: IdleGuardState = { ...state, phase };
      return {
        state: nextState,
        effects: [
          publish(nextState, settings, now),
          {
            type: 'SHOW_RELEASE_GUIDANCE',
            serverId: state.serverId ?? '',
            message: settings.autoRelease
              ? 'Notebook is busy; release will wait. Use Release now when ready.'
              : 'Automatic release is disabled. Use Release now when you are ready.',
          },
        ],
      };
    }
    case 'CANCEL': {
      if (state.status !== 'COUNTDOWN_WARNING' && state.status !== 'IDLE_DETECTED' && state.status !== 'ACTIVE') {
        return none(state);
      }
      if (state.status === 'ACTIVE') {
        const nextState: IdleGuardState = {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: null,
          reason: 'idle timer reset by user',
        };
        return { state: nextState, effects: [{ type: 'CANCEL_IDLE_TIMER' }, publish(nextState, settings, now)] };
      }
      const outcome = move(
        {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: null,
          countdownEndsAtMs: null,
          phase: null,
        },
        'ACTIVE',
        event.type,
        'countdown cancelled by user',
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    case 'SNOOZE': {
      if (
        state.status === 'DISABLED' ||
        state.status === 'TERMINATING' ||
        state.status === 'TERMINATED' ||
        state.status === 'ERROR' ||
        state.status === 'DISCONNECTED' ||
        state.status === 'SYNCING' ||
        state.status === 'UNSUPPORTED'
      ) {
        return none(state);
      }
      const untilMs = now + event.durationMs;
      if (state.status === 'ACTIVE') {
        const nextState: IdleGuardState = {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: untilMs,
          reason: 'Idle Guard snoozed by user',
        };
        return {
          state: nextState,
          effects: [
            { type: 'CANCEL_IDLE_TIMER' },
            { type: 'SET_SNOOZE', untilMs },
            publish(nextState, settings, now),
          ],
        };
      }
      const outcome = move(
        {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: untilMs,
          countdownEndsAtMs: null,
          phase: null,
        },
        'ACTIVE',
        event.type,
        'countdown snoozed by user',
        settings,
        now,
      );
      return finishMove(outcome, settings, now, [
        { type: 'CANCEL_IDLE_TIMER' },
        { type: 'SET_SNOOZE', untilMs },
        ...CANCEL_EFFECTS,
      ]);
    }
    case 'RELEASE_NOW': {
      if (state.status !== 'COUNTDOWN_WARNING' && state.status !== 'IDLE_DETECTED') {
        return none(state);
      }
      if (!state.serverId) {
        return {
          state,
          effects: [
            {
              type: 'SHOW_ERROR',
              code: 'SERVER_ID_UNAVAILABLE',
              message: 'No selected Colab server.',
              recoverable: true,
            },
          ],
        };
      }
      const outcome = move(
        state,
        'TERMINATING',
        event.type,
        'release requested by user',
        settings,
        now,
        { phase: 'terminating' },
      );
      return finishMove(outcome, settings, now, [
        { type: 'CANCEL_IDLE_TIMER' },
        { type: 'INVOKE_RELEASE', serverId: state.serverId },
        {
          type: 'SHOW_RELEASE_GUIDANCE',
          serverId: state.serverId,
          message: 'ColabDeck opened the Colab release dialog. Confirm the server there.',
        },
        { type: 'CANCEL_COUNTDOWN' },
      ]);
    }
    case 'RELEASE_SUCCEEDED': {
      if (state.status !== 'TERMINATING') {
        return none(state);
      }
      const outcome = move(
        {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: null,
          countdownEndsAtMs: null,
          phase: null,
        },
        'TERMINATED',
        event.type,
        'Colab server released',
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    case 'RELEASE_FAILED': {
      if (state.status !== 'TERMINATING') {
        return none(state);
      }
      const outcome = move(
        { ...state, countdownEndsAtMs: null, phase: null },
        'ERROR',
        event.type,
        event.message,
        settings,
        now,
      );
      return finishMove(outcome, settings, now, [
        ...CANCEL_EFFECTS,
        {
          type: 'SHOW_ERROR',
          code: 'RELEASE_FAILED',
          message: event.message,
          recoverable: true,
        },
      ]);
    }
    case 'RELEASE_CANCELLED': {
      if (state.status !== 'TERMINATING') {
        return none(state);
      }
      const outcome = move(
        {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: null,
          countdownEndsAtMs: null,
          phase: null,
        },
        'ACTIVE',
        event.type,
        event.reason,
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    case 'RETRY': {
      if (state.status !== 'ERROR') {
        return none(state);
      }
      const outcome = move(state, 'SYNCING', event.type, 'retry requested', settings, now);
      return finishMove(outcome, settings, now);
    }
    case 'PROBE_LOST': {
      if (state.status === 'DISABLED' || state.status === 'TERMINATING') {
        return none(state);
      }
      const outcome = move(
        {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: null,
          countdownEndsAtMs: null,
          phase: null,
        },
        'DISCONNECTED',
        event.type,
        event.reason,
        settings,
        now,
      );
      return finishMove(outcome, settings, now, CANCEL_EFFECTS);
    }
    case 'PROBE_ERROR': {
      if (state.status === 'DISABLED' || state.status === 'TERMINATING') {
        return none(state);
      }
      const outcome = move(
        {
          ...state,
          idleSinceMs: null,
          snoozedUntilMs: null,
          countdownEndsAtMs: null,
          phase: null,
        },
        'DISCONNECTED',
        event.type,
        event.message,
        settings,
        now,
      );
      return finishMove(outcome, settings, now, [
        ...CANCEL_EFFECTS,
        {
          type: 'SHOW_ERROR',
          code: 'PROBE_STALE',
          message: event.message,
          recoverable: true,
        },
      ]);
    }
  }
}
