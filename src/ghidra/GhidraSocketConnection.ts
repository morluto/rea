import { createConnection, type Socket } from "node:net";

import { err, ok, type Result } from "../domain/result.js";
import { GhidraSessionError } from "./GhidraSessionError.js";

/** Stable listeners attached for the lifetime of one bridge socket. */
export interface GhidraSocketHandlers {
  readonly data: (chunk: string) => void;
  readonly error: () => void;
  readonly close: () => void;
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

/** Open one abort-aware Ghidra Unix-socket connection attempt. */
export const connectGhidraSocketOnce = (
  socketPath: string,
  signal: AbortSignal,
): Promise<Result<Socket, GhidraSessionError>> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath);
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
            socket_path: socketPath,
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
            { socket_path: socketPath },
          ),
        ),
      );
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
