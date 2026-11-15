import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { outputContractDiagnostics } from "../domain/native/nativeProviderOutput.js";
import type { NativeOperationFactContract } from "../domain/native/nativeOperationFacts.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
  ExecutionOptions,
} from "../ports/AnalysisProvider.js";

/** A completed execution and its result parsed once against its named contract. */
export interface AnalysisFactExecution<Fact> {
  /** The provider's execution; its result stays the source value. */
  readonly execution: AnalysisExecution;
  readonly fact: Fact;
}

/**
 * Run one native operation through `port` and parse its result once against
 * the named contract. The call goes through the port's own `execute`, so a
 * wrapping port observes it as any other call. A mismatch is an
 * `AnalysisOutputError` naming the failed fields, keeping the execution as
 * partial observed Evidence.
 */
export const executeFact = async <Operation extends AnalysisOperation, Fact>(
  port: AnalysisOperationPort,
  contract: NativeOperationFactContract<Operation, Fact>,
  parameters: Readonly<Record<string, JsonValue>>,
  options?: ExecutionOptions,
): Promise<Result<AnalysisFactExecution<Fact>, AnalysisError>> => {
  const executed = await port.execute(contract.operation, parameters, options);
  if (!executed.ok) return executed;
  const parsed = contract.schema.safeParse(executed.value.result);
  if (parsed.success)
    return ok({ execution: executed.value, fact: parsed.data });
  return err(
    new AnalysisOutputError(
      contract.operation,
      `Provider returned an invalid ${contract.subject}`,
      {
        cause: parsed.error,
        diagnostics: outputContractDiagnostics(
          parsed.error,
          executed.value.result,
        ),
      },
    ).retainPartialObservation(
      createAnalysisExecutionEvidence(
        contract.operation,
        parameters,
        executed.value,
        "observed",
      ),
    ),
  );
};
