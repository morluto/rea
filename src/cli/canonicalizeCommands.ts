import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { cliDecimalField } from "./options.js";
import { createCanonicalizeService } from "../composition/canonicalize.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { canonicalizeArtifactInputSchema } from "../domain/canonicalize/canonicalizeArtifact.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";

/** Register the antidote canonicalizer through the same shared workflow as MCP. */
export const registerCanonicalizeCommands = (
  cli: CliInstance,
  logger: Logger,
  _environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.antidote, {
    description:
      "Antidote: canonicalize a selected artifact into bounded facts that neutralize decoy and padding shields, without executing it",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local artifact to canonicalize (WASM, Electron .asar or structured JSON)",
      ),
    }),
    options: z.object({
      format: canonicalizeArtifactInputSchema.shape.format.describe(
        "Normalizer selection: auto (default, recognize from bytes), wasm, asar or json",
      ),
      maxFileBytes: cliDecimalField(
        canonicalizeArtifactInputSchema.shape.max_file_bytes,
      ),
      maxFacts: cliDecimalField(
        canonicalizeArtifactInputSchema.shape.max_facts,
      ),
      maxDepth: cliDecimalField(
        canonicalizeArtifactInputSchema.shape.max_depth,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const canonicalize = createCanonicalizeService();
        return await logCliCommand(logger, CLI_COMMANDS.antidote, async () =>
          finishCliEvidenceCommand(
            args.path,
            () =>
              canonicalize.canonicalize(
                {
                  path: absoluteCallerPath(args.path),
                  format: options.format,
                  max_file_bytes: options.maxFileBytes,
                  max_facts: options.maxFacts,
                  max_depth: options.maxDepth,
                },
                { signal },
              ),
            canonicalize,
            "rea-canonicalize",
            "canonicalize_artifact",
            signal,
          ).then(projectCliAnalysisResult),
        );
      }),
  });
};
