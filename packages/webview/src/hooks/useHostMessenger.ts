import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  CountdownView,
  DashboardSnapshot,
  GpuProcessView,
  HostToWebviewMessage,
  NotebookMonitorView,
  IdleGuardTransitionView,
  IdleGuardView,
  TelemetrySample,
  TimeRange,
  ToolboxResult,
  UiError,
  WebviewToHostMessage,
} from '@colabdeck/shared';
import { mergeTelemetrySamples, replaceTelemetrySamples, timeRangeToMs, WEBVIEW_PROTOCOL_VERSION } from '@colabdeck/shared';

export interface HostState {
  readonly snapshot: DashboardSnapshot | null;
  readonly samples: readonly TelemetrySample[];
  readonly idle: IdleGuardView | null;
  readonly countdown: CountdownView | null;
  readonly transitions: readonly IdleGuardTransitionView[];
  readonly processes: readonly GpuProcessView[];
  readonly processSource: 'nvidia-smi' | 'procfs' | 'none';
  readonly processWarning: string | null;
  readonly toolboxResult: { readonly requestId: string; readonly result: ToolboxResult } | null;
  readonly errors: readonly UiError[];
  readonly mismatch: boolean;
  readonly range: TimeRange | null;
  readonly notebook: NotebookMonitorView | null;
}

const initialState: HostState = {
  snapshot: null,
  samples: [],
  idle: null,
  countdown: null,
  transitions: [],
  processes: [],
  processSource: 'none',
  processWarning: null,
  toolboxResult: null,
  errors: [],
  mismatch: false,
  range: null,
  notebook: null,
};

export function useHostMessenger(): {
  readonly state: HostState;
  readonly post: (message: WebviewToHostMessage) => void;
  readonly ready: boolean;
} {
  const apiRef = useRef<ReturnType<typeof acquireVsCodeApi> | null>(null);
  const serverIdRef = useRef<string | null>(null);
  const [state, setState] = useState<HostState>(initialState);
  const [ready, setReady] = useState(false);

  if (!apiRef.current) {
    apiRef.current = acquireVsCodeApi();
  }

  const post = (message: WebviewToHostMessage): void => {
    apiRef.current?.postMessage(message);
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebviewMessage>): void => {
      const message = event.data;
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        return;
      }
      switch (message.type) {
        case 'PROTOCOL_MISMATCH':
          setState((previous) => ({ ...previous, mismatch: true }));
          return;
        case 'SNAPSHOT':
          // A snapshot belongs to one server; never carry another server's chart into it.
          if (
            (serverIdRef.current !== null && serverIdRef.current !== message.snapshot.selectedServerId) ||
            message.snapshot.connection !== 'connected'
          ) {
            setState((previous) => ({
              ...previous,
              samples: [],
              processes: [],
              processSource: 'none',
              processWarning: null,
              toolboxResult: null,
            }));
          }
          serverIdRef.current = message.snapshot.selectedServerId;
          setState((previous) => ({
            ...previous,
            snapshot: message.snapshot,
            idle: message.snapshot.idleGuard,
            countdown: message.snapshot.countdown,
            errors: message.snapshot.errors,
          }));
          setReady(true);
          return;
        case 'NOTEBOOK_MONITOR':
          setState((previous) => ({ ...previous, notebook: message.view }));
          return;
        case 'TELEMETRY_BATCH':
          setState((previous) => ({
            ...previous,
            samples: replaceTelemetrySamples(previous.samples, message.samples),
            range: message.range,
          }));
          return;
        case 'TELEMETRY_APPEND':
          setState((previous) => ({
            ...previous,
            samples: mergeTelemetrySamples(
              previous.samples,
              [message.sample],
              previous.range === null ? null : timeRangeToMs(previous.range),
              Date.now(),
            ),
          }));
          return;
        case 'IDLE_GUARD_STATE':
          setState((previous) => ({
            ...previous,
            idle: message.state,
            countdown: message.countdown,
            transitions: message.recentTransitions,
          }));
          return;
        case 'GPU_PROCESSES':
          setState((previous) => ({
            ...previous,
            processes: message.processes,
            processSource: message.source,
            processWarning: message.warning,
          }));
          return;
        case 'TOOLBOX_RESULT':
          setState((previous) => ({
            ...previous,
            toolboxResult: { requestId: message.requestId, result: message.result },
          }));
          return;
        case 'ERROR':
          setState((previous) => {
            if (previous.errors.some((error) => error.id === message.errorId)) {
              return previous;
            }
            return {
              ...previous,
              errors: [
                ...previous.errors,
                {
                  id: message.errorId,
                  message: message.message,
                  detail: message.detail,
                  recoverable: message.recoverable,
                  action: message.action,
                },
              ],
            };
          });
          return;
        case 'SETTINGS_CHANGED':
          setState((previous) => ({
            ...previous,
            snapshot: previous.snapshot ? { ...previous.snapshot, settings: message.settings } : previous.snapshot,
          }));
          return;
        default:
          return;
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'READY', protocol: WEBVIEW_PROTOCOL_VERSION });
    return () => {
      window.removeEventListener('message', onMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, post, ready };
}
