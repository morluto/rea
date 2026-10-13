import { compareWasmInterfaces } from "../application/wasm/WasmInterfaceComparisonService.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { z } from "incur";
import { resolve } from "node:path";
import { wasmArtifactModule } from "../composition/wasm.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve all caller-selected artifact paths through the shared workflow. */
export const registerWasmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.compareWasmInterfaces, {
    description:
      "Compare core WASM interfaces from two exact inspection Evidence records",
    args: z.object({
      input: z
        .string()
        .describe(
          "Inline JSON or input file containing left/right complete Evidence and required scope",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) =>
        logCliCommand(logger, CLI_COMMANDS.compareWasmInterfaces, async () => {
          const input = await parseCliJsonInput(
            args.input,
            "compare_wasm_interfaces",
          );
          if (!input.ok) return input.error;
          const result = await compareWasmInterfaces(input.value, { signal });
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  const service = wasmArtifactModule.create(environment);
  cli.command(wasmArtifactModule.cliCommand, {
    description: "Inspect an explicit local WASM artifact with WABT",
    args: z.object({
      path: z.string().describe("Local WASM artifact"),
    }),
    options: z.object({
      glue_paths: z
        .array(z.string())
        .optional()
        .describe("Selected local JavaScript glue paths"),
      candidate_paths: z
        .array(z.string())
        .optional()
        .describe("Explicit local WASM candidates"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        try {
          return await logCliCommand(
            logger,
            wasmArtifactModule.cliCommand,
            async () => {
              const result = await service.inspect(
                {
                  path: resolve(args.path),
                  glue_paths: options.glue_paths?.map((path) => resolve(path)),
                  candidate_paths: options.candidate_paths?.map((path) =>
                    resolve(path),
                  ),
                },
                { signal },
              );
              return result.ok
                ? result.value
                : projectAnalysisError(result.error);
            },
          );
        } finally {
          await service.close();
        }
      }),
  });
};
