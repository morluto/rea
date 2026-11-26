import { once } from "node:events";
import type { Server } from "node:http";

import { isAbortOf } from "../../process/SignalAbort.js";

/** Cancel DNS/bind through Node's listener owner without coupling later shutdown to the startup signal. */
export const listenHttpServer = async (
  server: Server,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted();
  const startup = new AbortController();
  const cancel = () => startup.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    server.listen({ host, port, signal: startup.signal });
    await once(server, "listening", { signal: startup.signal });
    startup.signal.throwIfAborted();
  } catch (cause: unknown) {
    // Only startup's own abort is the caller's cancellation; another failure,
    // including an abort error with another reason, is reported as itself.
    if (isAbortOf(cause, startup.signal)) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            error === undefined ||
            ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
          )
            resolve();
          else reject(error);
        });
        server.closeAllConnections();
      });
      throw startup.signal.reason;
    }
    throw cause;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
};
