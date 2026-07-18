import type {
  ClientConfigurationResult,
  SetupClient,
  SetupHost,
  SetupProviderEnvironment,
  SetupProgressEvent,
} from "./Setup.js";

const failedConfigurationMessage = (
  reason: "path" | "backup" | "write" | "readback",
): string => {
  if (reason === "path")
    return "Agent configuration path could not be safely verified. Check its permissions and, if it is a symbolic link, verify that the link resolves to a regular file owned by the current user, then rerun setup.";
  if (reason === "backup")
    return "Agent configuration could not be backed up, so no change was made. Check file permissions, then rerun setup.";
  if (reason === "write")
    return "Agent configuration could not be updated. Check file permissions, then rerun setup.";
  return "Agent configuration could not be verified after writing. Repair the configuration file or restore its `.rea.backup`, then rerun setup.";
};

/** Configure every detected agent and report the first failed transaction. */
export const configureDetectedClients = async (options: {
  readonly host: SetupHost;
  readonly detectedClients: readonly SetupClient[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly command: readonly string[];
  readonly clients: Record<string, ClientConfigurationResult>;
  readonly appliedActions: string[];
  readonly onProgress?: (event: SetupProgressEvent) => void;
}): Promise<string | undefined> => {
  let failure: string | undefined;
  for (const client of options.detectedClients) {
    const actionId = `configure_client:${client.name}`;
    const label = client.displayName ?? client.name;
    options.onProgress?.({ actionId, label, state: "started" });
    const result = await options.host.configureClient(
      client,
      options.providerEnvironment,
      options.command,
    );
    options.clients[client.name] = result;
    if (result.status === "failed") {
      failure ??= failedConfigurationMessage(result.reason);
      options.onProgress?.({
        actionId,
        label,
        state: "failed",
        detail: failedConfigurationMessage(result.reason),
      });
    } else if (result.status === "configured") {
      options.appliedActions.push(`configured_${client.name}`);
      options.onProgress?.({ actionId, label, state: "completed" });
    } else {
      options.onProgress?.({
        actionId,
        label,
        state: "warning",
        detail:
          result.status === "unchanged"
            ? "Already current"
            : "Manual configuration required",
      });
    }
  }
  return failure;
};
