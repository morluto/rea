import { createConnection, type Socket } from "node:net";
import { err, ok, type Result } from "../domain/result.js";

type LocalSocketTarget =
  | { readonly path: string }
  | { readonly host: string; readonly port: number };
type LocalSocketFailure =
  | { readonly kind: "error"; readonly cause: Error }
  | { readonly kind: "cancelled"; readonly reason: unknown };

/** Open one local socket and hand it to the caller only after connection. */
export const connectLocalSocketOnce = (
  target: LocalSocketTarget,
  signal: AbortSignal,
): Promise<Result<Socket, LocalSocketFailure>> =>
  signal.aborted
    ? Promise.resolve(err({ kind: "cancelled", reason: signal.reason }))
    : new Promise((resolve) => {
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
          resolve(err({ kind: "error", cause }));
        };
        const onAbort = (): void => {
          detach();
          socket.destroy();
          resolve(err({ kind: "cancelled", reason: signal.reason }));
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
