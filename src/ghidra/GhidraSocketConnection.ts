import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { Socket } from "node:net";
import { connectLocalSocketOnce } from "../process/LocalSocketConnection.js";

import { err, ok, type Result } from "../domain/result.js";
import type { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import {
  GHIDRA_STARTUP_DEADLINE_ELAPSED,
  type GhidraSessionError,
  type GhidraSessionFailureFactory,
} from "./GhidraSessionError.js";
import {
  type GhidraEndpoint,
  observeGhidraEndpoint,
} from "./GhidraTransport.js";

/** Stable listeners attached for the lifetime of one bridge socket. */
interface GhidraSocketHandlers {
  readonly data: (chunk: Buffer) => void;
  readonly end: () => void;
  readonly error: () => void;
  readonly close: () => void;
}

/** Inputs needed to poll and attach one authenticated bridge socket. */
export interface GhidraSocketConnectOptions {
  readonly endpoint: GhidraEndpoint;
  readonly resourceScope: ArtifactResourceScope;
  readonly deadline: ProviderStartupDeadline;
  readonly failure: GhidraSessionFailureFactory;
  readonly isClosed: () => boolean;
  readonly processExited: () => boolean;
  readonly startupTimeoutMs: number;
  readonly handlers: GhidraSocketHandlers;
}

/** Attach raw bridge listeners and return an idempotent detach callback. */
const attachGhidraSocket = (
  socket: Socket,
  handlers: GhidraSocketHandlers,
): (() => void) => {
  socket.on("data", handlers.data);
  socket.on("end", handlers.end);
  socket.on("error", handlers.error);
  socket.on("close", handlers.close);
  return () => {
    socket.off("data", handlers.data);
    socket.off("end", handlers.end);
    socket.off("error", handlers.error);
    socket.off("close", handlers.close);
  };
};

/** Poll the endpoint and attach the first ready bridge socket. */
export const connectGhidraSocket = async (
  options: GhidraSocketConnectOptions,
): Promise<
  Result<
    { readonly socket: Socket; readonly detach: () => void },
    GhidraSessionError
  >
> => {
  while (options.deadline.remainingMs() > 0) {
    if (options.deadline.signal.aborted)
      return err(interruptionFailure(options));
    if (options.isClosed())
      return err(options.failure("cancelled", "Ghidra startup was closed"));
    if (options.processExited())
      return err(
        options.failure("process", "Ghidra exited before bridge startup"),
      );
    const observed = await observeGhidraEndpoint(options.endpoint, {
      signal: options.deadline.signal,
      resourceScope: options.resourceScope,
    });
    if (!observed.ok) {
      if (
        observed.error.kind !== "cancelled" ||
        options.deadline.interruption === undefined
      )
        return observed;
      return err(interruptionFailure(options, observed.error));
    }
    if (observed.value === null) {
      if ((await options.deadline.wait(50)) === "aborted")
        return err(interruptionFailure(options));
      continue;
    }
    const connected = await connectLocalSocketOnce(
      observed.value,
      options.deadline.signal,
    );
    if (connected.ok) {
      const detach = attachGhidraSocket(connected.value, options.handlers);
      return ok({ socket: connected.value, detach });
    }
    if ((await options.deadline.wait(50)) === "aborted")
      return err(interruptionFailure(options));
  }
  return err(
    options.failure("timeout", GHIDRA_STARTUP_DEADLINE_ELAPSED, undefined, {
      timeoutMs: options.startupTimeoutMs,
    }),
  );
};

const interruptionFailure = (
  options: GhidraSocketConnectOptions,
  cause?: GhidraSessionError,
): GhidraSessionError => {
  const failure =
    options.deadline.interruption === "cancelled"
      ? options.failure("cancelled", "Ghidra startup was cancelled", cause, {
          cancellation: { reason: options.deadline.signal.reason },
        })
      : options.failure("timeout", GHIDRA_STARTUP_DEADLINE_ELAPSED, cause, {
          timeoutMs: options.startupTimeoutMs,
        });
  return cause?.cleanupFailure === undefined
    ? failure
    : failure.withCleanupFailure(cause.cleanupFailure);
};
