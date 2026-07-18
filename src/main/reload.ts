import { parseConfig } from "../config.js";
import { readProjectPermissionStore } from "../application/ProjectPermissionStore.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { PermissionGrant } from "../domain/permissionPolicy.js";
import type { Logger } from "../logger.js";
import type { RuntimeDependencies } from "./types.js";
import type { RuntimeState } from "./state.js";
import { MCP_PERMISSION_RELOAD_FAILED } from "./messages.js";

type McpServerInstance = ReturnType<
  typeof import("../server/createServer.js").createServer
>;

export const registerConfigReload = (input: {
  readonly dependencies: RuntimeDependencies;
  readonly permissionAuthority: PermissionAuthority;
  readonly runtimeState: RuntimeState;
  readonly liveServers: Set<McpServerInstance>;
  readonly serverLogger: Logger;
}): (() => void) => {
  const {
    dependencies,
    permissionAuthority,
    runtimeState,
    liveServers,
    serverLogger,
  } = input;
  let reloadQueue = Promise.resolve();
  return (
    dependencies.registerReload?.(() => {
      const refreshed = parseConfig(dependencies.env);
      if (!refreshed.ok) {
        serverLogger.error("Reloaded permission policy is invalid");
        return;
      }
      reloadQueue = reloadQueue
        .then(async () => {
          let projectGrants: readonly PermissionGrant[] = [];
          if (
            refreshed.value.permissionProjectRoot !== undefined &&
            refreshed.value.permissionProjectStore !== undefined
          ) {
            const project = await (
              dependencies.readProjectPermissionStore ??
              readProjectPermissionStore
            )(
              refreshed.value.permissionProjectStore,
              refreshed.value.permissionProjectRoot,
            );
            if (!project.ok) {
              serverLogger.error("Reloaded project grants could not be read");
              return;
            }
            projectGrants = project.value?.grants ?? [];
          }
          const reloaded = await permissionAuthority.replaceConfiguredPolicy({
            ceilings: refreshed.value.permissionCeilings,
            administratorGrants: refreshed.value.administratorPermissionGrants,
            projectGrants,
          });
          if (!reloaded.ok) {
            serverLogger.error(
              "Reloaded permission policy could not be applied",
            );
            return;
          }
          runtimeState.currentConfig = refreshed.value;
          Object.assign(
            runtimeState.processPolicy,
            refreshed.value.processExecutionPolicy,
          );
          Object.assign(
            runtimeState.evidencePolicy,
            refreshed.value.evidenceFilePolicy,
          );
          Object.assign(
            runtimeState.snapshotPolicy,
            refreshed.value.analysisSnapshotFilePolicy,
          );
          runtimeState.investigationRoots.splice(
            0,
            runtimeState.investigationRoots.length,
            ...refreshed.value.investigationInputRoots,
          );
          Object.assign(
            runtimeState.javascriptReplayPolicy,
            refreshed.value.javascriptReplayPolicy,
          );
          Object.assign(
            runtimeState.managedRuntimePolicy,
            refreshed.value.managedRuntimePolicy,
          );
          for (const server of liveServers) server.sendToolListChanged();
        })
        .catch(() => {
          serverLogger.error(MCP_PERMISSION_RELOAD_FAILED);
        });
    }) ?? (() => undefined)
  );
};
