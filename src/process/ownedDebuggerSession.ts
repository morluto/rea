/** Result of terminating one debugger process owned by this application. */
export type OwnedDebuggerStopResult =
  | { readonly status: "stopped" | "already_exited" }
  | { readonly status: "incomplete"; readonly reason: string };

interface OwnedDebuggerProcess {
  readonly id: string;
  readonly exited: boolean;
  readonly launched: {
    readonly process: { kill(signal: NodeJS.Signals): boolean };
  };
  readonly supervisor: {
    waitForExit(timeoutMs: number): Promise<boolean>;
    dispose(): void;
  };
}

/** Stop only the directly owned debugger process, never its process group or target. */
export const stopOwnedDebuggerProcess = async (
  session: OwnedDebuggerProcess,
  debuggerName: string,
): Promise<OwnedDebuggerStopResult> => {
  if (session.exited) {
    session.supervisor.dispose();
    return { status: "already_exited" };
  }
  session.launched.process.kill("SIGTERM");
  if (!(await session.supervisor.waitForExit(300))) {
    session.launched.process.kill("SIGKILL");
    if (!(await session.supervisor.waitForExit(1_000))) {
      session.supervisor.dispose();
      return {
        status: "incomplete",
        reason: `Owned ${debuggerName} process did not exit after direct termination.`,
      };
    }
  }
  session.supervisor.dispose();
  return { status: "stopped" };
};

/** Stop every owned session and retain failed sessions for possible recovery. */
export const closeOwnedDebuggerSessions = async <
  Session extends { id: string },
>(
  sessions: Map<string, Session>,
  stop: (session: Session) => Promise<OwnedDebuggerStopResult>,
  debuggerName: string,
): Promise<void> => {
  const results = await Promise.all(
    [...sessions.values()].map(async (session) => ({
      session,
      result: await stop(session),
    })),
  );
  const failures = results.filter(
    ({ result }) => result.status === "incomplete",
  );
  for (const { session, result } of results)
    if (result.status !== "incomplete") sessions.delete(session.id);
  if (failures.length > 0)
    throw new AggregateError(
      failures.map(({ result }) =>
        result.status === "incomplete"
          ? new Error(result.reason)
          : new Error(`Unknown ${debuggerName} shutdown failure`),
      ),
      `One or more owned ${debuggerName} processes did not stop cleanly`,
    );
};
