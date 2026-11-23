#!/usr/bin/env node

import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { HOST_PLATFORM } from "./platform/HostPlatform.js";
import {
  CURRENT_ENTRYPOINT_PATH,
  isDirectEntrypoint,
} from "./process/CurrentEntrypointPath.js";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config/parseConfig.js";
import type { McpHttpCommand } from "./cliBuiltinArguments.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { RuntimeDependencies } from "./main/types.js";
import { runDeferred } from "./main/deferredRuntime.js";
import { RECORDED_MCP_CATALOG_SHA256 } from "./recordedMcpCatalog.js";
import { SERVER_START_FAILED } from "./server/serverStartFailure.js";

import {
  createExitStatus,
  latchSignalShutdown,
  registerProcessShutdown,
  registerSignalShutdown,
  type ExitStatus,
  type SignalLatch,
} from "./main/processShutdown.js";
import {
  parseMcpHttpEndpoint,
  type McpHttpEndpoint,
} from "./config/mcpHttpEndpoint.js";

const runtimeDependencies = (): RuntimeDependencies => ({
  env: process.env,
  stdin: process.stdin,
  serve: serveStdio,
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  registerShutdown: registerProcessShutdown,
});

/** Replace stdio with the streamable HTTP listener; signals alone end it, never stdin. */
const httpRuntimeDependencies = (
  endpoint: McpHttpEndpoint,
  latch: SignalLatch,
  exit: ExitStatus,
): RuntimeDependencies => {
  const base = runtimeDependencies();
  return {
    ...base,
    transport: "http",
    setExitCode: exit.set,
    serve: async (factory, options) => {
      // Loaded here so the default stdio entry never loads the HTTP listener.
      const { serveStreamableHttp } =
        await import("./server/http/serveStreamableHttp.js");
      const { RequestTrackingMcpServer } =
        await import("./server/RequestTrackingMcpServer.js");
      // The transport's factory owner closes every instance it created; the listener must not race it.
      return serveStreamableHttp({
        ...endpoint,
        createMcpServer: async (context) => {
          const server = await factory(context);
          if (!(server instanceof RequestTrackingMcpServer))
            throw new TypeError("HTTP MCP servers must track tool completion");
          return server;
        },
        closeInstance: false,
        ...options,
      });
    },
    registerShutdown: (request) => {
      const unregister = registerSignalShutdown((exitStatus) => {
        exit.signal(exitStatus);
        request();
      });
      // A signal that arrived during startup is honoured now that the lifecycle owner exists;
      // its status outlives the entry's own `0`, which startup returns right after this.
      const pending = latch.release();
      if (pending !== undefined) {
        exit.signal(pending);
        request();
      }
      return unregister;
    },
  };
};

/** Start discovery without constructing unused analysis validators. */
export const run = async (
  dependencies: RuntimeDependencies = runtimeDependencies(),
): Promise<number> => {
  const environment = snapshotEnvironment(
    dependencies.env,
    HOST_PLATFORM.platform,
  );
  const config = parseConfig(environment);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  // The deferred server omits the recorded output schemas from listings, the
  // default `off` profile; `compact` composes its bounded presentation.
  const recordedOutputCatalog =
    config.value.mcpOutputSchemaProfile !== "compact";
  // Progressive discovery needs scoped identity before the first analysis.
  // Ordinary tool listings can defer that identity to the canonical runtime.
  const scopedProgressiveCatalog =
    config.value.mcpToolFamilies !== undefined &&
    config.value.mcpToolCatalogProfile === "hot-cold";
  if (
    RECORDED_MCP_CATALOG_SHA256 !== undefined &&
    dependencies.transport !== "http" &&
    config.value.hopperTargetPath === undefined &&
    recordedOutputCatalog &&
    !scopedProgressiveCatalog &&
    dependencies.createServer === undefined &&
    dependencies.loadOptionalProviders === undefined
  ) {
    return runDeferred({ ...dependencies, env: environment }, config.value);
  }
  return (await import("./main/eagerRuntime.js")).runEager(
    { ...dependencies, env: environment },
    config.value,
  );
};

/** Only the production entrypoints read the account's configuration file. */
const runWithUserConfiguration = async (
  dependencies: RuntimeDependencies,
): Promise<number> => {
  const { loadUserConfiguration } =
    await import("./application/UserConfigurationStore.js");
  const configuration = await loadUserConfiguration(
    snapshotEnvironment(dependencies.env, HOST_PLATFORM.platform),
  );
  if (!configuration.ok) {
    dependencies.writeStderr(`${configuration.error.message}\n`);
    return 1;
  }
  return run({ ...dependencies, env: configuration.value.environment });
};

/** Run the executable boundary without exposing an unexpected startup cause. */
export const runEntrypoint = async (
  start: () => Promise<number> = () =>
    runWithUserConfiguration(runtimeDependencies()),
  writeStderr: (text: string) => void = (text) => process.stderr.write(text),
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  try {
    setExitCode(await start());
  } catch (cause: unknown) {
    // Intentionally redact the startup cause from caller-visible output;
    // unexpected failures must not leak internal details.
    void cause;
    writeStderr(`${SERVER_START_FAILED}\n`);
    setExitCode(1);
  }
};

/** Process streams the dispatcher entries write to. */
export interface EntrypointIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

const processIo: EntrypointIo = {
  writeStdout: (text) => void process.stdout.write(text),
  writeStderr: (text) => void process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

/** Validate the selected HTTP command, resolve MCP_HOST/MCP_PORT, then serve over HTTP. */
export const runMcpHttpEntrypoint = async (
  command: McpHttpCommand,
  io: EntrypointIo = processIo,
): Promise<void> => {
  const { validateMcpHttpCommand, renderMcpHttpHelp } =
    await import("./main/mcpHttpArguments.js");
  const parsed = validateMcpHttpCommand(command);
  if (!parsed.ok) {
    if (parsed.help) {
      io.writeStdout(`${renderMcpHttpHelp()}\n`);
      io.setExitCode(0);
      return;
    }
    io.writeStderr(`${parsed.message}\n`);
    io.setExitCode(1);
    return;
  }
  const endpoint = parseMcpHttpEndpoint(
    snapshotEnvironment(process.env, HOST_PLATFORM.platform),
    {
      ...(parsed.host === undefined ? {} : { host: parsed.host }),
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      ...(parsed.allowedHosts === undefined
        ? {}
        : { allowedHosts: [...parsed.allowedHosts] }),
    },
  );
  if (!endpoint.ok) {
    io.writeStderr(`${projectAnalysisError(endpoint.error).message}\n`);
    io.setExitCode(1);
    return;
  }
  // Latched before any asynchronous startup so a signal cannot end the process without cleanup.
  const latch = latchSignalShutdown();
  const exit = createExitStatus(io.setExitCode);
  try {
    await runEntrypoint(
      () =>
        runWithUserConfiguration(
          httpRuntimeDependencies(endpoint.value, latch, exit),
        ),
      io.writeStderr,
      exit.set,
    );
  } finally {
    latch.release();
  }
};

if (isDirectEntrypoint(CURRENT_ENTRYPOINT_PATH, import.meta.url)) {
  void runEntrypoint();
}
