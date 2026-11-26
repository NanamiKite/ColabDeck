import type { JSX } from 'preact';
import { formatDuration } from '@colabdeck/shared';
import type { CountdownView, IdleGuardTransitionView, IdleGuardView } from '@colabdeck/shared';

function humanizeReason(reason: string): string {
  const text = reason.replace(/-/g, ' ').replace(/\bgpu\b/gi, 'GPU');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface IdleGuardCardProps {
  readonly idle: IdleGuardView | null;
  readonly countdown: CountdownView | null;
  readonly transitions: readonly IdleGuardTransitionView[];
  readonly countdownMs: number;
  readonly snoozeMinutes: number;
  readonly onToggle: (enabled: boolean) => void;
  readonly onCancel: () => void;
  readonly onSnooze: () => void;
  readonly onRelease: () => void;
}

export function IdleGuardCard({
  idle,
  countdown,
  transitions,
  countdownMs,
  snoozeMinutes,
  onToggle,
  onCancel,
  onSnooze,
  onRelease,
}: IdleGuardCardProps): JSX.Element | null {
  if (!idle) {
    return null;
  }
  const remaining = countdown?.remainingMs ?? 0;
  const progress = countdown ? Math.max(0, Math.min(100, (remaining / Math.max(1, countdownMs)) * 100)) : 0;
  const canCancel = idle.status === 'COUNTDOWN_WARNING' || idle.status === 'IDLE_DETECTED';
  const canSnooze = idle.status === 'COUNTDOWN_WARNING' || idle.status === 'IDLE_DETECTED' || idle.status === 'ACTIVE';
  const canRelease = idle.status === 'COUNTDOWN_WARNING' || idle.status === 'IDLE_DETECTED';
  const statusLabels: Readonly<Record<string, string>> = {
    DISABLED: 'Off',
    DISCONNECTED: 'Disconnected',
    SYNCING: 'Starting',
    ACTIVE: 'Active',
    IDLE_DETECTED: 'Idle',
    COUNTDOWN_WARNING: 'Warning',
    TERMINATING: 'Stopping',
    TERMINATED: 'Released',
    ERROR: 'Error',
    UNSUPPORTED: 'Unavailable',
  };
  const statusLabel = statusLabels[idle.status] ?? 'Unknown';
  const showsIdleTiming =
    idle.status === 'ACTIVE' || idle.status === 'IDLE_DETECTED' || idle.status === 'COUNTDOWN_WARNING';
  const idleTimingLabel = showsIdleTiming
    ? `threshold ${idle.thresholdPct.toFixed(0)}% · idle ${formatDuration(idle.idleForMs)} (limit ${formatDuration(idle.idleThresholdMs)})`
    : idle.status === 'DISCONNECTED'
      ? 'No server connected'
      : idle.status === 'SYNCING'
        ? 'Waiting for telemetry'
        : idle.status === 'DISABLED'
          ? 'Idle Guard is off'
          : '';
  return (
    <section class="card idle-card">
      <div class="card-head">
        <div>
          <div class="eyebrow">Cost control</div>
          <h2>Idle Guard</h2>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            aria-label="Idle Guard"
            checked={idle.enabled}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
          <span>{idle.enabled ? 'ON' : 'OFF'}</span>
        </label>
      </div>
      <div class="idle-status">
        <span class={`status-pill ${idle.status.toLowerCase()}`}>{statusLabel}</span>
        <span class="muted">{idleTimingLabel}</span>
      </div>
      {idle.snoozedUntilMs ? (
        <p class="muted">Snoozed until {new Date(idle.snoozedUntilMs).toLocaleTimeString()}.</p>
      ) : null}
      {idle.reason ? <p class="muted">Reason: {humanizeReason(idle.reason)}</p> : null}
      {idle.kernelBusy === true ? (
        <p class="warning-text">Notebook is busy; automatic release is paused.</p>
      ) : null}
      {countdown ? (
        <div class="countdown">
          <div class="countdown-head">
            <span>{countdown.phase === 'expired' ? 'Countdown expired' : countdown.phase === 'kernel-busy' ? 'Waiting' : countdown.phase === 'terminating' ? 'Releasing…' : 'Countdown'}</span>
            <strong>{formatDuration(countdown.remainingMs)}</strong>
          </div>
          <div class="bar-track countdown-track">
            <div class="bar-fill countdown-fill" style={{ width: `${progress}%` }} />
          </div>
          {countdown.phase === 'expired' ? (
            <p class="muted">Automatic release is off. Use Release now when ready.</p>
          ) : null}
          {countdown.phase !== 'expired' && !countdown.autoRelease ? (
            <p class="warning-text">
              Automatic release is off; use Release now when the countdown ends.
            </p>
          ) : null}
          {countdown.phase === 'kernel-busy' ? (
            <p class="muted">Notebook is busy; release will wait.</p>
          ) : null}
        </div>
      ) : null}
      <div class="button-row">
        <button class="secondary" disabled={!canCancel} onClick={onCancel}>
          Cancel
        </button>
        <button class="secondary" disabled={!canSnooze} onClick={onSnooze}>
          Snooze {snoozeMinutes}m
        </button>
        <button class="danger" disabled={!canRelease} onClick={onRelease}>
          Release now
        </button>
      </div>
      {idle.status === 'UNSUPPORTED' ? (
        <p class="muted">No GPU detected; Idle Guard is off.</p>
      ) : null}
      {idle.status === 'TERMINATING' ? (
        <p class="muted">Confirm release in the Colab dialog.</p>
      ) : null}
      {transitions.length > 0 ? (
        <details class="transitions">
          <summary>Recent state transitions ({transitions.length})</summary>
          <ul>
            {transitions.slice(-10).reverse().map((transition, index) => (
              <li key={`${transition.atMs}-${transition.to}-${index}`}>
                <span>{new Date(transition.atMs).toLocaleTimeString()}</span>
                <span>{statusLabels[transition.from] ?? transition.from} → {statusLabels[transition.to] ?? transition.to}</span>
                <span class="muted">{humanizeReason(transition.reason)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
