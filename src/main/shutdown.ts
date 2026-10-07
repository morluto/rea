import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import type { BinarySession } from "../application/binary/BinarySession.js";
import type { Logger } from "../logger.js";
import type { RuntimeDependencies } from "./types.js";
import { MCP_SHUTDOWN_FAILED } from "./messages.js";

export const createShutdown = (input: {
  readonly handle: StdioServerHandle;
  readonly closeAndroid?: () => Promise<void>;
  readonly session: BinarySession;
  readonly unregisterReload: () => void;
  readonly dependencies: RuntimeDependencies;
  readonly serverLogger: Logger;
}): {
  readonly shutdown: () => Promise<void>;
  readonly request: () => void;
} => {
  const { handle, session, unregisterReload, dependencies, serverLogger } =
    input;
  let shutdownPromise: Promise<void> | undefined;
  let unregisterShutdown = (): void => undefined;
  const shutdown = async (): Promise<void> => {
    shutdownPromise ??= (async () => {
      unregisterReload();
      unregisterShutdown();
      const results = await Promise.allSettled([
        handle.close(),
        input.closeAndroid?.(),
        session.close({ retainProviderDocuments: true }),
      ]);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    })();
    return shutdownPromise;
  };
  const requestShutdown = (): void => {
    shutdown().catch((cause: unknown) => {
      serverLogger.debug(
        { failure_cause: describeShutdownFailure(cause) },
        "MCP shutdown rejected",
      );
      dependencies.setExitCode(1);
      serverLogger.error(MCP_SHUTDOWN_FAILED);
      dependencies.writeStderr(`${MCP_SHUTDOWN_FAILED}\n`);
    });
  };
  unregisterShutdown = dependencies.registerShutdown(requestShutdown);
  return { shutdown, request: requestShutdown };
};

const describeShutdownFailure = (
  cause: unknown,
): Readonly<Record<string, string | number | boolean | null>> => {
  if (cause instanceof Error) {
    const code = "code" in cause ? cause.code : undefined;
    return {
      name: cause.name,
      message: cause.message,
      ...(typeof code === "string" ||
      (typeof code === "number" && Number.isFinite(code))
        ? { code }
        : {}),
    };
  }
  if (
    cause === null ||
    typeof cause === "string" ||
    typeof cause === "boolean" ||
    (typeof cause === "number" && Number.isFinite(cause))
  )
    return { type: cause === null ? "null" : typeof cause, value: cause };
  return { type: typeof cause };
};
