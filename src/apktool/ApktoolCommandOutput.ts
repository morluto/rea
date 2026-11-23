import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

/** The command owner selects command output or preparation output, once. */
export const capturedApktoolFailureOutput = (
  cause: unknown,
): AnalysisCapturedOutput | undefined => {
  if (cause instanceof OwnedCommandFailure)
    return cause.snapshot === null
      ? cause.preparationFailure instanceof
        DarwinProcessOwnershipInspectionError
        ? cause.preparationFailure.capturedOutput
        : undefined
      : capturedProviderOutput(cause.snapshot);
  return cause instanceof DarwinProcessOwnershipInspectionError
    ? cause.capturedOutput
    : undefined;
};
