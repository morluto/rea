import type {
  DebuggerCleanupIncomplete,
  DebuggerCleanupIncompleteCode,
} from "../domain/debuggerSessionErrors.js";

/** Closing all sessions could not confirm that these debuggers stopped. */
export class OwnedDebuggerCleanupError extends AggregateError {
  /** Process IDs when cleanup gave up. Observations, not lasting proof of identity. */
  readonly retainedProcessIds: readonly number[];

  constructor(
    failures: readonly Error[],
    message: string,
    retainedProcessIds: readonly number[],
  ) {
    super(failures, message);
    this.retainedProcessIds = retainedProcessIds;
  }
}

/** One owned debugger whose stop could not be confirmed, naming why. */
export class OwnedDebuggerStopFailure extends Error {
  readonly code: DebuggerCleanupIncompleteCode;
  constructor(stop: DebuggerCleanupIncomplete) {
    super(stop.reason);
    this.name = "OwnedDebuggerStopFailure";
    this.code = stop.code;
  }
}

/** Visit every error in a composed cleanup failure once. */
const visitCleanupFailure = (
  cause: unknown,
  onError: (error: Error) => void,
): void => {
  const visited = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || visited.has(node)) return;
    visited.add(node);
    if (node instanceof Error) onError(node);
    if (node instanceof AggregateError)
      for (const error of node.errors) visit(error);
    if (node instanceof Error) visit(node.cause);
  };
  visit(cause);
};

/** Retained debugger process IDs anywhere in a composed cleanup failure. */
export const retainedDebuggerProcessIds = (
  cause: unknown,
): readonly number[] => {
  const found = new Set<number>();
  visitCleanupFailure(cause, (error) => {
    if (error instanceof OwnedDebuggerCleanupError)
      for (const pid of error.retainedProcessIds) found.add(pid);
  });
  return [...found];
};

/** Why each unconfirmed debugger stop in a composed cleanup failure is incomplete. */
export const debuggerCleanupCodes = (
  cause: unknown,
): readonly DebuggerCleanupIncompleteCode[] => {
  const found = new Set<DebuggerCleanupIncompleteCode>();
  visitCleanupFailure(cause, (error) => {
    if (error instanceof OwnedDebuggerStopFailure) found.add(error.code);
  });
  return [...found];
};

/** Log or diagnostic fields naming those processes; empty when none are known. */
export const retainedDebuggerDiagnostics = (
  cause: unknown,
): {
  readonly retained_debugger_pids?: number[];
  readonly debugger_cleanup_codes?: DebuggerCleanupIncompleteCode[];
} => {
  const pids = retainedDebuggerProcessIds(cause);
  const codes = debuggerCleanupCodes(cause);
  return {
    ...(pids.length === 0 ? {} : { retained_debugger_pids: [...pids] }),
    ...(codes.length === 0 ? {} : { debugger_cleanup_codes: [...codes] }),
  };
};

/** What a caller must do once REA ends with these debuggers unconfirmed. */
export const retainedDebuggerRemediation = (pids: readonly number[]): string =>
  `REA exits without confirming that the debugger stopped, and no later REA command can retry this cleanup. Check process ${pids.join(", ")} and its target, and stop them if they are still running.`;
