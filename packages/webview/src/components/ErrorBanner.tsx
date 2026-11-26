import type { JSX } from 'preact';
import type { UiError } from '@colabdeck/shared';

interface ErrorBannerProps {
  readonly errors: readonly UiError[];
  readonly onDismiss: (id: string) => void;
  readonly onAction: (action: UiError['action']) => void;
}

const ACTION_LABELS: Readonly<Record<UiError['action'], string>> = {
  RETRY: 'Retry',
  OPEN_SETTINGS: 'Open settings',
  OPEN_PROBE_LOG: 'View diagnostics',
  NONE: 'Dismiss',
};

export function ErrorBanner({ errors, onDismiss, onAction }: ErrorBannerProps): JSX.Element | null {
  if (errors.length === 0) {
    return null;
  }
  return (
    <div class="error-list">
      {errors.map((error) => (
        <div class="error-item" key={error.id}>
          <div class="error-body">
            <strong>{error.message}</strong>
            {error.detail ? (
              <details class="error-details">
                <summary>Details</summary>
                <div class="muted">{error.detail}</div>
              </details>
            ) : null}
          </div>
          <div class="button-row">
            {error.action !== 'NONE' ? (
              <button
                class="secondary small"
                aria-label={ACTION_LABELS[error.action]}
                onClick={() => onAction(error.action)}
              >
                {ACTION_LABELS[error.action]}
              </button>
            ) : null}
            <button
              class="icon-button"
              title="Dismiss"
              aria-label="Dismiss error"
              onClick={() => onDismiss(error.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
