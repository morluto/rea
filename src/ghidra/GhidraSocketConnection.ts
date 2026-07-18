import { createConnection, type Socket } from "node:net";

import { err, ok, type Result } from "../domain/result.js";
import type { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import {
  GhidraSessionError,
  type GhidraSessionErrorOptions,
  type GhidraSessionFailureKind,
} from "./GhidraSessionError.js";
import {
  type GhidraConnectTarget,
  type GhidraEndpoint,
  observeGhidraEndpoint,
} from "./GhidraTransport.js";

/** Stable listeners attached for the lifetime of one bridge socket. */
export interface GhidraSocketHandlers {
  readonly data: (chunk: string) => void;
  readonly error: () => void;
  readonly close: () => void;
}

/** Inputs needed to poll and attach one authenticated bridge socket. */
export interface GhidraSocketConnectOptions {
  readonly endpoint: GhidraEndpoint;
  readonly deadline: ProviderStartupDeadline;
  readonly failure: (
    kind: GhidraSessionFailureKind,
    message: string,
    cause?: unknown,
    options?: Pick<GhidraSessionErrorOptions, "timeoutMs" | "remoteCode">,
  ) => GhidraSessionError;
  readonly isClosed: () => boolean;
  readonly processExited: () => boolean;
  readonly startupTimeoutMs: number;
  readonly handlers: GhidraSocketHandlers;
}

/** Attach decoded bridge listeners and return an idempotent detach callback. */
export const attachGhidraSocket = (
  socket: Socket,
  handlers: GhidraSocketHandlers,
): (() => void) => {
  socket.setEncoding("utf8");
  socket.on("data", handlers.data);
  socket.on("error", handlers.error);
  socket.on("close", handlers.close);
  return () => {
    socket.off("data", handlers.data);
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
    const observed = await observeGhidraEndpoint(options.endpoint);
    if (!observed.ok) return observed;
    if (observed.value === null) {
      if ((await options.deadline.wait(50)) === "aborted")
        return err(interruptionFailure(options));
      continue;
    }
    const connected = await connectGhidraSocketOnce(
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
    options.failure("timeout", "Ghidra startup deadline elapsed", undefined, {
      timeoutMs: options.startupTimeoutMs,
    }),
  );
};

/** Open one abort-aware connection to an observed local Ghidra endpoint. */
export const connectGhidraSocketOnce = (
  target: GhidraConnectTarget,
  signal: AbortSignal,
): Promise<Result<Socket, GhidraSessionError>> =>
  new Promise((resolve) => {
    const socket =
      "path" in target
        ? createConnection(target.path)
        : createConnection({ host: target.host, port: target.port });
    const detach = (): void => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onConnect = (): void => {
      detach();
      resolve(ok(socket));
    };
    const onError = (cause: Error): void => {
      detach();
      socket.destroy();
      resolve(
        err(
          new GhidraSessionError("start", "Ghidra bridge connection failed", {
            endpoint: target,
            error: cause.message,
          }),
        ),
      );
    };
    const onAbort = (): void => {
      detach();
      socket.destroy();
      resolve(
        err(
          new GhidraSessionError(
            "cancelled",
            "Ghidra bridge connection was cancelled",
            { endpoint: target },
          ),
        ),
      );
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

const interruptionFailure = (
  options: GhidraSocketConnectOptions,
): GhidraSessionError =>
  options.deadline.cancelled
    ? options.failure("cancelled", "Ghidra startup was cancelled")
    : options.failure("timeout", "Ghidra startup deadline elapsed", undefined, {
        timeoutMs: options.startupTimeoutMs,
      });
