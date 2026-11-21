import type { Logger } from "pino";

import { CLI_COMMANDS } from "../contracts/cliCommandNames.js";
import { createCanonicalizeService } from "../composition/canonicalize.js";
import { CANONICALIZE_TOOL_CONTRACTS } from "../contracts/canonicalize/canonicalizeToolContracts.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  callerTargetPath,
  registerContractCommand,
} from "./contractCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/**
 * Register the antidote canonicalizer through the shared contract-command path,
 * the same registration MCP uses, so the CLI and the contract cannot drift and
 * shared parity coverage includes this command.
 */
export const registerCanonicalizeCommands = (
  cli: CliInstance,
  logger: Logger,
  _environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(CANONICALIZE_TOOL_CONTRACTS, "canonicalize_artifact"),
    {
      command: CLI_COMMANDS.antidote,
      description:
        "Antidote: canonicalize a selected artifact into bounded facts that neutralize decoy and padding shields, without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description:
            "Local artifact to canonicalize (WASM, Electron .asar or structured JSON)",
        },
        format: {
          // The global CLI `--format` selects output rendering, so the input
          // normalizer needs its own flag or `antidote --format wasm` would be
          // parsed as an output-format choice and fail. Mirror apiContract's
          // `contractFormat` rename rather than overload the shared option.
          name: "antidoteFormat",
          description:
            "Input normalizer selection: auto (default, recognize from bytes), wasm, asar or json",
        },
        max_file_bytes: {
          description:
            "Maximum stable artifact bytes to read; bounds the pass's own memory",
        },
        max_facts: {
          description: "Maximum exemplar facts retained per collection",
        },
        max_depth: {
          description: "Maximum behavior-relevant structural depth to descend",
        },
      },
    },
    (input, context) => {
      const canonicalize = createCanonicalizeService();
      return finishCliEvidenceCommand(
        callerTargetPath(context),
        () => canonicalize.canonicalize(input, { signal: context.signal }),
        canonicalize,
        "rea-canonicalize",
        context.operation,
        context.signal,
      ).then(projectCliAnalysisResult);
    },
  );
};
