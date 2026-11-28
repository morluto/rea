import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "../../ports/AnalysisProvider.js";
import {
  AnalysisOutputError,
  cancelledBy,
  isAborted,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analyzeProcedureHardwareInstructions } from "../../domain/firmware/hardwareInstructionClassifiers.js";
import type {
  HardwareInstructionChannelsResult,
  InspectProcedureHardwareInstructionsInput,
} from "../../domain/firmware/hardwareInstructionChannels.js";
import { functionInstructionWindowSchema } from "../../domain/native/functionDossier.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_procedure_hardware_instructions";

/** Compose `read_function_instructions` with ISA-specific hardware channel extraction. */
export const inspectProcedureHardwareInstructions = async (
  analysis: AnalysisOperationPort,
  input: InspectProcedureHardwareInstructionsInput,
  options?: ExecutionOptions,
): Promise<Result<HardwareInstructionChannelsResult, AnalysisError>> => {
  if (isAborted(options?.signal)) {
    return err(cancelledBy(OPERATION, options?.signal));
  }
  const executed = await analysis.execute(
    "read_function_instructions",
    { procedure: input.procedure },
    { ...options, retainEvidence: true },
  );
  if (!executed.ok) return executed;
  if (isAborted(options?.signal)) {
    return err(cancelledBy(OPERATION, options?.signal));
  }

  const parsed = functionInstructionWindowSchema.safeParse(
    executed.value.result,
  );
  if (!parsed.success) {
    return err(
      new AnalysisOutputError(
        "read_function_instructions",
        "Provider output did not match functionInstructionWindowSchema.",
        { cause: parsed.error },
      ),
    );
  }

  return ok(
    analyzeProcedureHardwareInstructions({
      procedure: parsed.data.procedure,
      architecture: input.hardware_architecture,
      instructions: parsed.data.instructions,
      upstreamLimitations: parsed.data.limitations,
    }),
  );
};
