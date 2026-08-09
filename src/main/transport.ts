import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import type { BinarySession } from "../application/BinarySession.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { Logger } from "../logger.js";
import {
  createServer,
  type CreateServerOptions,
} from "../server/createServer.js";
import type { RuntimeDependencies } from "./types.js";
import type { RuntimeState } from "./state.js";
import {
  MCP_CONNECTION_LOST,
  MCP_CONNECTION_START_FAILED,
} from "./messages.js";

type McpServerInstance = ReturnType<typeof createServer>;

/** Optional adapters whose absence must not prevent the core MCP server. */
export type OptionalProviders = Pick<
  CreateServerOptions,
  | "browserObservation"
  | "browserScenarioCapture"
  | "electronObservation"
  | "electronActiveObservation"
  | "javascriptRuntimeObservation"
>;

interface ServerContext {
  readonly logger: Logger;
  readonly serverLogger: Logger;
  readonly loadOptionalProviders: () => Promise<OptionalProviders>;
  readonly permissionAuthority: PermissionAuthority;
  readonly runtimeState: RuntimeState;
}

export const startMcpTransport = async (
  dependencies: RuntimeDependencies,
  session: BinarySession,
  serverContext: ServerContext,
): Promise<
  | {
      readonly ok: true;
      readonly handle: StdioServerHandle;
      readonly liveServers: Set<McpServerInstance>;
    }
  | { readonly ok: false }
> => {
  const liveServers = new Set<McpServerInstance>();
  const { serverLogger } = serverContext;
  let optionalProviders: OptionalProviders = {};
  try {
    optionalProviders = await serverContext.loadOptionalProviders();
  } catch {
    serverLogger.warn(
      "Optional MCP providers could not load; affected tools remain unavailable",
    );
  }
  let handle: StdioServerHandle;
  try {
    handle = dependencies.serve(
      () => {
        const server = (dependencies.createServer ?? createServer)(
          session,
          session,
          {
            logger: serverContext.logger,
            processPolicy: () =>
              serverContext.runtimeState.currentConfig.processExecutionPolicy,
            evidenceFilePolicy: serverContext.runtimeState.evidencePolicy,
            investigationInputRoots:
              serverContext.runtimeState.investigationRoots,
            analysisSnapshotFilePolicy:
              serverContext.runtimeState.snapshotPolicy,
            permissionAuthority: serverContext.permissionAuthority,
            ...optionalProviders,
            artifactIntegrityContinueEnabled: () =>
              serverContext.runtimeState.currentConfig
                .artifactIntegrityContinueEnabled,
            javascriptReplayPolicy: () =>
              serverContext.runtimeState.currentConfig.javascriptReplayPolicy,
            managedRuntimePolicy: () =>
              serverContext.runtimeState.currentConfig.managedRuntimePolicy,
            availabilityPolicy: () =>
              runtimeAvailability(serverContext.runtimeState),
          },
        );
        liveServers.add(server);
        return server;
      },
      {
        onerror: () => {
          serverLogger.error(MCP_CONNECTION_LOST);
          dependencies.writeStderr(`${MCP_CONNECTION_LOST}\n`);
        },
      },
    );
  } catch {
    await session.close();
    serverLogger.error(MCP_CONNECTION_START_FAILED);
    dependencies.writeStderr(`${MCP_CONNECTION_START_FAILED}\n`);
    return { ok: false };
  }
  return { ok: true, handle, liveServers };
};

const runtimeAvailability = (state: RuntimeState) => ({
  processCaptureEnabled:
    state.currentConfig.processExecutionPolicy.status === "enabled",
  evidenceFileRoots: state.currentConfig.evidenceFilePolicy.roots.length,
  investigationInputRoots: state.currentConfig.investigationInputRoots.length,
  browserObservationEnabled:
    state.currentConfig.browserObservationPolicy.status === "enabled",
  browserScenarioEnabled:
    state.currentConfig.browserScenarioPolicy.status === "enabled",
  electronObservationEnabled:
    state.currentConfig.electronObservationPolicy.status === "enabled",
  electronAutomationEnabled:
    state.currentConfig.electronAutomationPolicy.status === "enabled",
  v8InspectorObservationEnabled:
    state.currentConfig.v8InspectorObservationPolicy.status === "enabled",
  javascriptReplayEnabled:
    state.currentConfig.javascriptReplayPolicy.status === "enabled",
  managedRuntimeEnabled:
    state.currentConfig.managedRuntimePolicy.status === "enabled",
});
