import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { compareWasmInterfaces } from "../application/wasm/WasmInterfaceComparisonService.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { z } from "incur";
import { wasmArtifactModule } from "../composition/wasm.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";

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
          "Inline JSON or input file containing left/right Evidence or retained references and required scope",
        ),
    }),
    options: z.object({ evidenceBundle: evidenceBundleOption }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) =>
        logCliCommand(logger, CLI_COMMANDS.compareWasmInterfaces, async () => {
          const input = await parseCliJsonInput(
            args.input,
            "compare_wasm_interfaces",
            signal,
          );
          if (!input.ok) return input.error;
          return runEvidenceInputCommand(
            "compare_wasm_interfaces",
            options.evidenceBundle,
            signal,
            async (lookup) => {
              const result = await compareWasmInterfaces(
                input.value,
                { signal },
                lookup,
              );
              return result.ok
                ? { ok: true, value: result.value.evidence }
                : result;
            },
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
  const service = wasmArtifactModule.create(environment);
  registerContractCommand(
    cli,
    logger,
    wasmArtifactModule.contract,
    {
      command: wasmArtifactModule.cliCommand,
      description: "Inspect an explicit local WASM artifact with WABT",
      positionals: ["path"],
      callerPaths: ["path", "glue_paths", "candidate_paths"],
      fields: {
        path: { description: "Local WASM artifact" },
        glue_paths: {
          name: "glue_paths",
          description: "Selected local JavaScript glue paths",
        },
        candidate_paths: {
          name: "candidate_paths",
          description: "Explicit local WASM candidates",
        },
      },
      omit: {
        detail:
          "One-shot output is complete Evidence; this command has no summary delivery",
      },
    },
    inspectWithService(() => service, "wabt-artifact"),
  );
};
