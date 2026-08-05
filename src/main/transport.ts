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

interface ServerContext {
  readonly logger: Logger;
  readonly serverLogger: Logger;
  readonly loadOptionalProviders: NonNullable<
    CreateServerOptions["loadOptionalProviders"]
  >;
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
  let handle: StdioServerHandle;
  try {
    handle = dependencies.serve(
      () => {
        const server = (dependencies.createServer ?? createServer)(
          session,
          session,
          {
            logger: serverContext.logger,
            processPolicy: serverContext.runtimeState.processPolicy,
            evidenceFilePolicy: serverContext.runtimeState.evidencePolicy,
            investigationInputRoots:
              serverContext.runtimeState.investigationRoots,
            analysisSnapshotFilePolicy:
              serverContext.runtimeState.snapshotPolicy,
            permissionAuthority: serverContext.permissionAuthority,
            loadOptionalProviders: serverContext.loadOptionalProviders,
            artifactIntegrityContinueEnabled: () =>
              serverContext.runtimeState.currentConfig
                .artifactIntegrityContinueEnabled,
            javascriptReplayPolicy:
              serverContext.runtimeState.javascriptReplayPolicy,
            managedRuntimePolicy:
              serverContext.runtimeState.managedRuntimePolicy,
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
  processCaptureEnabled: state.currentConfig.processExecutionPolicy.enabled,
  evidenceFileRoots: state.currentConfig.evidenceFilePolicy.roots.length,
  investigationInputRoots: state.currentConfig.investigationInputRoots.length,
  browserObservationEnabled:
    state.currentConfig.browserObservationEnabled &&
    state.currentConfig.browserCdpEndpoints.length > 0 &&
    state.currentConfig.browserAllowedOrigins.length > 0,
  browserScenarioEnabled:
    state.currentConfig.browserScenarioPolicy.enabled &&
    state.currentConfig.browserScenarioPolicy.allowedOrigins.length > 0 &&
    (state.currentConfig.browserScenarioPolicy.executableRoots.length > 0 ||
      state.currentConfig.browserScenarioPolicy.cdpEndpoints.length > 0),
  electronObservationEnabled:
    state.currentConfig.electronObservationEnabled &&
    state.currentConfig.electronCdpEndpoints.length > 0 &&
    state.currentConfig.electronFileRoots.length > 0,
  electronAutomationEnabled:
    state.currentConfig.electronAutomationPolicy.enabled &&
    state.currentConfig.electronAutomationPolicy.executableRoots.length > 0 &&
    state.currentConfig.electronAutomationPolicy.applicationRoots.length > 0,
  v8InspectorObservationEnabled:
    state.currentConfig.v8InspectorObservationEnabled &&
    state.currentConfig.v8InspectorEndpoints.length > 0 &&
    (state.currentConfig.v8InspectorFileRoots.length > 0 ||
      state.currentConfig.v8InspectorAllowedOrigins.length > 0),
  javascriptReplayEnabled: state.currentConfig.javascriptReplayPolicy.enabled,
  managedRuntimeEnabled: state.currentConfig.managedRuntimePolicy.enabled,
});
