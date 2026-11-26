declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): T | undefined;
};
