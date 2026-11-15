import { JebAnalysisService } from "../application/jeb/JebAnalysisService.js";
import type { JebAnalysisPort } from "../application/jeb/JebAnalysisPort.js";
import { createJebAnalysisProvider } from "../composition/jeb.js";
import { JEB_TOOL_CONTRACTS } from "../contracts/jeb/jebToolContracts.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { JebOperation } from "../domain/jeb/jebAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  analyzeWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";

/** Expose the same explicit JEB requests through one-shot CLI commands. */
export const registerJebCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: JebAnalysisPort = createJebAnalysisProvider(environment),
): void => {
  const service = new JebAnalysisService(provider);
  const run = (operation: JebOperation) => (): EvidenceInspectionService => ({
    inspect: (input, { signal }) =>
      service.execute(operation, input, { signal }),
    close: () => provider.close(),
  });
  const contract = <Name extends JebOperation>(name: Name) =>
    contractNamed(JEB_TOOL_CONTRACTS, name);

  registerContractCommand(
    cli,
    logger,
    contract("inspect_jeb_client"),
    {
      command: CLI_COMMANDS.inspectJebClient,
      description:
        "Inspect the running JEB MCP client without opening a target",
    },
    analyzeWithService(run("inspect_jeb_client"), "jeb"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("open_jeb_project"),
    {
      command: CLI_COMMANDS.openJebProject,
      description:
        "Open or create a JEB project from an artifact or .jdb2 database",
      // JEB resolves the path it is given; the CLI passes it on as spelled
      // and records that spelling in Evidence.
      positionals: ["path"],
    },
    (input, { operation, signal }) => {
      const owned = run("open_jeb_project")();
      return finishCliEvidenceCommand(
        input.path,
        () => owned.inspect(input, { signal }),
        owned,
        "jeb",
        operation,
        signal,
      ).then(projectCliAnalysisResult);
    },
  );
  registerContractCommand(
    cli,
    logger,
    contract("list_jeb_units"),
    {
      command: CLI_COMMANDS.listJebUnits,
      description:
        "List JEB project units by path and type with optional filter",
    },
    analyzeWithService(run("list_jeb_units"), "jeb"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("decompile_jeb_item"),
    {
      command: CLI_COMMANDS.decompileJebItem,
      description: "Decompile one JEB type or method to engine pseudo-code",
      positionals: ["item_address", "item_kind"],
    },
    analyzeWithService(run("decompile_jeb_item"), "jeb"),
  );
};
