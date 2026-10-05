import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";

const OPERATION = "capture_browser_scenario" as const;

export const withPlaywrightExecutionBoundary = <Value>(
  work: () => Promise<Value>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<Value> => {
  if (timeoutMs !== undefined && timeoutMs <= 0)
    return Promise.reject(new AnalysisTimeoutError(OPERATION, timeoutMs));
  if (signal?.aborted === true)
    return Promise.reject(new AnalysisCancelledError(OPERATION));

  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline =
      timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const scheduleTimeout = (): void => {
      if (deadline === undefined) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        fail(new AnalysisTimeoutError(OPERATION, timeoutMs ?? 0));
        return;
      }
      timer = setTimeout(scheduleTimeout, Math.min(remaining, 2_147_483_647));
      timer.unref();
    };
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (value: Value): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      fail(new AnalysisCancelledError(OPERATION));
    };
    scheduleTimeout();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    void work().then(succeed, fail);
  });
};
