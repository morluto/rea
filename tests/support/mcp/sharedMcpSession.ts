/** One file-scoped stdio MCP session. */
export interface SharedMcpSession<T> {
  call(): Promise<T>;
}

const sharedMcpSessionClosed = (): Error =>
  new Error("Shared MCP session is closed");

/** Keep the handshake as the caller error and retain the cleanup failure beside it. */
const startupFailureWithCleanup = (
  startup: unknown,
  cleanup: unknown,
): Error => {
  const primary =
    startup instanceof Error ? startup : new Error(String(startup));
  return new Error(primary.message, {
    cause: new AggregateError([primary, cleanup], primary.message, {
      cause: primary,
    }),
  });
};

/**
 * Start at most one server for the file. Close waits for startup still in
 * flight. A connector that sees `isClosed` can skip the server; a server
 * registered after close is still cleaned up. A failed cleanup stays owned,
 * and the next call does not open another server until that cleanup succeeds.
 */
export const createSharedMcpSession = <T>(
  connect: (
    registerCleanup: (cleanup: () => Promise<void>) => void,
    isClosed: () => boolean,
  ) => Promise<T>,
): { session: SharedMcpSession<T>; close(): Promise<void> } => {
  let pending: Promise<T> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let closeGeneration: symbol | undefined;
  let cleanupQueue: Promise<void> = Promise.resolve();
  const cleanups: Array<() => Promise<void>> = [];
  const drain = (): Promise<void> => {
    const run = cleanupQueue
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        const failures: unknown[] = [];
        const retained: Array<() => Promise<void>> = [];
        while (cleanups.length > 0) {
          const cleanup = cleanups.pop();
          if (cleanup === undefined) break;
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
            retained.push(cleanup);
          }
        }
        for (const cleanup of retained.reverse()) cleanups.push(cleanup);
        // A reasonless rejection is `undefined` and still owns the cleanup.
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Shared MCP session cleanup failed",
          );
        }
        if (failures.length === 1) throw failures[0];
      });
    cleanupQueue = run;
    return run;
  };
  const registerCleanup = (cleanup: () => Promise<void>): void => {
    cleanups.push(cleanup);
  };
  return {
    session: {
      call: () => {
        if (closed) return Promise.reject(sharedMcpSessionClosed());
        pending ??= (async () => {
          try {
            if (cleanups.length > 0) await drain();
          } catch (cleanupError) {
            // Close owns cleanup once shutdown has started, so a failed
            // handshake cannot clear the startup close is awaiting.
            if (!closed) pending = undefined;
            throw cleanupError;
          }
          if (closed) throw sharedMcpSessionClosed();
          try {
            const opened = await connect(registerCleanup, () => closed);
            if (closed) throw sharedMcpSessionClosed();
            return opened;
          } catch (error) {
            if (!closed) {
              pending = undefined;
              try {
                await drain();
              } catch (cleanupError) {
                throw startupFailureWithCleanup(error, cleanupError);
              }
            }
            throw error;
          }
        })();
        return pending;
      },
    },
    close: () => {
      closed = true;
      if (closing !== undefined) return closing;
      const starting = pending;
      const generation = Symbol("shared-mcp-close");
      closeGeneration = generation;
      const attempt = (async () => {
        try {
          if (starting !== undefined) {
            await starting.catch(() => undefined);
          }
          await drain();
        } catch (error) {
          // A failed close stays retryable. Completion is cached only after
          // every retained cleanup has succeeded.
          if (closeGeneration === generation) {
            closing = undefined;
            closeGeneration = undefined;
          }
          throw error;
        }
      })();
      closing = attempt;
      return attempt;
    },
  };
};
