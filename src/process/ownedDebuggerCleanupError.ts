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

/** Retained debugger process IDs anywhere in a composed cleanup failure. */
export const retainedDebuggerProcessIds = (
  cause: unknown,
): readonly number[] => {
  const found = new Set<number>();
  const visited = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || visited.has(node)) return;
    visited.add(node);
    if (node instanceof OwnedDebuggerCleanupError)
      for (const pid of node.retainedProcessIds) found.add(pid);
    if (node instanceof AggregateError)
      for (const error of node.errors) visit(error);
    if (node instanceof Error) visit(node.cause);
  };
  visit(cause);
  return [...found];
};

/** Log or diagnostic fields naming those processes; empty when none are known. */
export const retainedDebuggerDiagnostics = (
  cause: unknown,
): { readonly retained_debugger_pids?: number[] } => {
  const pids = retainedDebuggerProcessIds(cause);
  return pids.length === 0 ? {} : { retained_debugger_pids: [...pids] };
};

/** What a caller must do once REA ends with these debuggers unconfirmed. */
export const retainedDebuggerRemediation = (pids: readonly number[]): string =>
  `REA exits without confirming that the debugger stopped, and no later REA command can retry this cleanup. Check process ${pids.join(", ")} and its target, and stop them if they are still running.`;
