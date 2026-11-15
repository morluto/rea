import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createBeamService } from "../composition/erlang.js";
import { ERLANG_BEAM_TOOL_CONTRACTS } from "../contracts/erlang/beamToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Inspect operator-selected BEAM files through the same shared workflow as MCP. */
export const registerErlangCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(ERLANG_BEAM_TOOL_CONTRACTS, "inspect_erlang_beam"),
    {
      command: CLI_COMMANDS.inspectErlangBeam,
      description:
        "Inspect Erlang BEAM atoms, exports, imports and Code header without executing bytecode",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      fields: {
        path: { description: "Local BEAM file" },
        view: {
          description:
            "JSON beam view; requires --detail summary and --evidence_output",
        },
      },
    },
    deliverWithService(createBeamService, "rea-erlang-beam"),
  );
};
