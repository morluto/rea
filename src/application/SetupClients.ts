import type {
  ClientConfigurationResult,
  SetupClient,
  SetupHost,
} from "./Setup.js";

const failedConfigurationMessage = (
  reason: "backup" | "write" | "readback",
): string => {
  if (reason === "backup")
    return "Agent configuration could not be backed up, so no change was made. Check file permissions, then rerun setup.";
  if (reason === "write")
    return "Agent configuration could not be updated. Check file permissions, then rerun setup.";
  return "Agent configuration could not be verified after writing. Repair the configuration file or restore its `.rea.backup`, then rerun setup.";
};

/** Configure every detected agent and report all failed transaction classes. */
export const configureDetectedClients = async (options: {
  readonly host: SetupHost;
  readonly detectedClients: readonly SetupClient[];
  readonly hopperPath: string | undefined;
  readonly command: readonly string[];
  readonly clients: Record<string, ClientConfigurationResult>;
  readonly appliedActions: string[];
}): Promise<string | undefined> => {
  const failures = new Set<"backup" | "write" | "readback">();
  for (const client of options.detectedClients) {
    const result = await options.host.configureClient(
      client,
      options.hopperPath,
      options.command,
    );
    options.clients[client.name] = result;
    if (result.status === "failed") failures.add(result.reason);
    if (result.status === "configured")
      options.appliedActions.push(`configured_${client.name}`);
  }
  return failures.size === 0
    ? undefined
    : [...failures].map(failedConfigurationMessage).join(" ");
};
