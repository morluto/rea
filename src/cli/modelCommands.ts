import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createModelArtifactService } from "../composition/model.js";
import { INSPECT_MODEL_ARTIFACT_CONTRACT } from "../contracts/model/modelToolContracts.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** One-shot summaries export the same complete observations used by MCP retained pages. */
export const registerModelCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const deliver = deliverWithService(
    createModelArtifactService,
    "model-artifact",
  );
  registerContractCommand(
    cli,
    logger,
    INSPECT_MODEL_ARTIFACT_CONTRACT,
    {
      command: CLI_COMMANDS.inspectModelArtifact,
      description:
        "Inspect GGUF or safetensors headers without loading model weights",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      viewDelivery: {
        invalidJson: "view must be a JSON model page selection",
        kind: "model-artifact",
      },
      fields: {
        path: { description: "Local model file, detected by content" },
        hash: {
          description:
            "header reads declarations only; full additionally streams all bytes for SHA-256",
        },
        view: {
          description:
            "JSON model page selection; requires --detail summary and --evidence_output",
        },
      },
    },
    // The CLI delivers the summary itself, so the service returns complete
    // Evidence; the contract's own default would retain a summary instead.
    (input, context) => deliver({ ...input, detail: "complete" }, context),
  );
};
