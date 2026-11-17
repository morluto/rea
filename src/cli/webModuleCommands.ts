import type { Logger } from "pino";

import { createWebModuleTraceService } from "../composition/webModules.js";
import { WEB_SCRIPT_TOOL_CONTRACTS } from "../contracts/webScriptToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/** Expose the same selected-context module trace through the CLI. */
export const registerWebModuleCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = createWebModuleTraceService(environment);
  registerContractCommand(
    cli,
    logger,
    contractNamed(WEB_SCRIPT_TOOL_CONTRACTS, "trace_web_module_imports"),
    {
      description:
        "Trace one captured script's native imports to URLs and captured source candidates",
      positionals: ["manifest_path", "script_index"],
      callerPaths: ["manifest_path"],
      fields: {
        manifest_path: {
          description:
            "export_web_scripts manifest path; a relative path resolves against the current directory",
        },
        script_index: { description: "Zero-based manifest script index" },
      },
      flatten: {
        import_map: {
          path: {
            name: "importMapPath",
            description:
              "Absolute local import-map JSON path; requires --import-map-base-url",
          },
          base_url: {
            name: "importMapBaseUrl",
            description:
              "HTTP(S) import-map base URL; requires --import-map-path",
          },
        },
      },
    },
    // CLI and MCP return the same trace Evidence, without a caller spelling.
    (input, { operation, signal }) =>
      finishAnalysisCommand(
        () => service.trace(input, { signal }),
        service,
        "web-module-trace",
        operation,
        signal,
      ).then(projectCliAnalysisResult),
  );
};
