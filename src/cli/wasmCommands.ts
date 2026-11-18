import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { compareWasmInterfaces } from "../application/wasm/WasmInterfaceComparisonService.js";
import { wasmArtifactModule } from "../composition/wasm.js";
import { COMPARE_WASM_INTERFACES_CONTRACT } from "../contracts/wasm/wasmComparisonContracts.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import {
  inspectWithService,
  registerContractCommand,
  registerContractDocumentCommand,
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
  registerContractDocumentCommand(
    cli,
    logger,
    COMPARE_WASM_INTERFACES_CONTRACT,
    {
      description:
        "Compare core WASM interfaces from two exact inspection Evidence records",
      document:
        "Inline JSON or input file containing left/right Evidence or retained references and required scope",
      cliOptions: { evidenceBundle: evidenceBundleOption },
    },
    (document, { signal, operation, frame, cliOptions }) =>
      runEvidenceInputCommand(
        document,
        { operation, signal, frame, cliOptions },
        async (lookup) => {
          const result = await compareWasmInterfaces(
            document,
            { signal },
            lookup,
          );
          return result.ok
            ? { ok: true, value: result.value.evidence }
            : result;
        },
      ).then(projectCliAnalysisResult),
  );
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
