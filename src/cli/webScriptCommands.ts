import type { Logger } from "pino";

import { exportWebScripts } from "../application/WebScriptExportService.js";
import { ArtifactResourceScope } from "../resources/index.js";
import { WEB_SCRIPT_TOOL_CONTRACTS } from "../contracts/webScriptToolContracts.js";
import { WEB_SCRIPT_EXPORT_PROVIDER } from "../domain/investigationProviders.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { CliInstance } from "./types.js";

/** Register the local captured-script export CLI workflow. */
export const registerWebScriptCommands = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(WEB_SCRIPT_TOOL_CONTRACTS, "export_web_scripts"),
    {
      description:
        "Export retained website scripts into an absent directory for static JavaScript analysis",
      positionals: ["capture_path", "output_directory"],
      callerPaths: ["capture_path", "output_directory"],
      fields: {
        capture_path: {
          description:
            "Saved inspect_web_page or capture_browser_scenario JSON, normalized result or complete Evidence; a relative path resolves against the current directory",
        },
        output_directory: {
          description:
            "Absent directory for verified scripts and manifest; its parent must exist. A relative path resolves against the current directory",
        },
      },
    },
    async (input, { operation, signal }) => {
      const resources = new ArtifactResourceScope();
      const result = await finishAnalysisCommand(
        () => exportWebScripts(input, resources, { signal }),
        resources,
        WEB_SCRIPT_EXPORT_PROVIDER.id,
        operation,
        signal,
        "Web script export resources",
      );
      return result.ok
        ? result.value
        : { error: "Script export failed", ...result.error };
    },
  );
