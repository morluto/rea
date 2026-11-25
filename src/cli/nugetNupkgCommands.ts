import type { Logger } from "pino";

import { createNugetNupkgService } from "../composition/nugetNupkg.js";
import { NUGET_NUPKG_TOOL_CONTRACTS } from "../contracts/nuget/nupkgToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** Inspect operator-selected NuGet packages through the same shared workflow as MCP. */
export const registerNugetNupkgCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(NUGET_NUPKG_TOOL_CONTRACTS, "inspect_nuget_nupkg"),
    {
      description:
        "Inspect NuGet .nupkg identity, dependency groups and ZIP contents without restore or network",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: { path: { description: "Local NuGet .nupkg package" } },
    },
    deliverWithService(createNugetNupkgService, "rea-nuget-nupkg"),
  );
};
