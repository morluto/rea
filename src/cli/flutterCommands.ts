import type { RequestAnalysisPort } from "../ports/AnalysisProvider.js";
import type {
  FlutterRequest,
  FlutterOperation,
} from "../domain/flutter/flutterBuildAnalysis.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { withEvidenceCallerInputPath } from "../domain/evidence.js";
import { recognizeEvidence } from "../domain/evidenceValidation.js";
import { createFlutterBuildAnalysisService } from "../application/ProviderOperationServices.js";
import { createFlutterBuildAnalysisProvider } from "../composition/flutter.js";
import { FLUTTER_TOOL_CONTRACTS } from "../contracts/flutter/flutterToolContracts.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  type ContractCommandContext,
} from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { bindCliEvidenceCallerPath } from "./cliEvidenceCallerPath.js";

/** Expose the same explicit Flutter requests through one-shot CLI commands. */
export const registerFlutterCommands = (
  cli: CliInstance,
  logger: Logger,
  provider: RequestAnalysisPort<FlutterRequest> = createFlutterBuildAnalysisProvider(),
): void => {
  /**
   * Run one operation on the APK the caller selected, recording that spelling
   * in Evidence, including a result completed before cleanup failed. The
   * contract admits a relative path, resolved by the provider from the working
   * directory, so the CLI passes it on as spelled.
   */
  const run =
    (operation: FlutterOperation) =>
    (input: { readonly path: string }, { signal }: ContractCommandContext) =>
      finishAnalysisCommand(
        bindCliEvidenceCallerPath(input.path, () =>
          createFlutterBuildAnalysisService(provider).execute(
            operation,
            input,
            {
              signal,
            },
          ),
        ),
        { close: () => provider.close() },
        "flutter",
        operation,
        signal,
        undefined,
        {
          recoverCompletedObservation: (observation) => {
            // Only authenticated Evidence is recovered; otherwise the error stands.
            const parsed = recognizeEvidence(observation);
            return parsed.ok && parsed.value !== undefined
              ? withEvidenceCallerInputPath(parsed.value, input.path)
              : undefined;
          },
        },
      ).then(projectCliAnalysisResult);

  registerContractCommand(
    cli,
    logger,
    contractNamed(FLUTTER_TOOL_CONTRACTS, "identify_flutter_build"),
    {
      description:
        "Identify a Flutter build's Dart snapshot hash and engine facts by pure APK parsing",
      positionals: ["path"],
      jsonText: ["apk_limits"],
    },
    run("identify_flutter_build"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(FLUTTER_TOOL_CONTRACTS, "inspect_dart_aot"),
    {
      description:
        "Inspect one ABI's Dart AOT snapshot: sections, headers, and the string pool",
      positionals: ["path"],
      jsonText: ["pool_policy", "apk_limits"],
      omit: {
        detail:
          "The CLI returns complete Evidence; a summary needs a session that retains it for inspect_analysis_view",
      },
    },
    run("inspect_dart_aot"),
  );
};
