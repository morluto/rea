import { parseAnalysisInput } from "./AnalysisInput.js";
import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "./AnalysisProvider.js";
import { nativeProcedureInputSchema } from "../domain/native/nativeProcedureInput.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import { parseFunctionDossier } from "../domain/native/functionDossier.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";
import type { Evidence } from "../domain/evidence.js";
import { EvidenceLedger } from "./investigation/EvidenceLedger.js";
import {
  recordEvidenceSources,
  withEvidenceSources,
  type AnalysisResultWithSources,
} from "./investigation/recordEvidenceSources.js";

/**
 * Preserve the provider's observations when presenting a validated function
 * dossier. Parameters are the provider input only: adapters separate delivery
 * options such as MCP detail before calling.
 */
export const executeFunctionAnalysisEvidence = async (
  analysis: AnalysisOperationPort,
  parameters: Readonly<Record<string, JsonValue>>,
  target: BinaryTarget | undefined,
  options?: ExecutionOptions,
): Promise<AnalysisResultWithSources<Evidence>> => {
  const input = parseAnalysisInput(
    "analyze_function",
    parameters,
    nativeProcedureInputSchema,
    options?.signal,
  );
  if (!input.ok) return input;
  const arguments_ = input.value;
  const execution = await analysis.execute(
    "analyze_function",
    arguments_,
    options,
  );
  if (!execution.ok) return execution;
  const sourceLedger = new EvidenceLedger();
  const recorded = recordEvidenceSources(
    (source) => sourceLedger.record(source),
    execution.value.sourceEvidence ?? [],
  );
  const sources = sourceLedger.recordsForAnalysis();
  if (!recorded.ok) return withEvidenceSources(recorded, sources);
  const dossier = parseFunctionDossier(execution.value.result);
  if (!dossier.ok) return withEvidenceSources(dossier, sources);
  const observation = execution.value;
  return withEvidenceSources(
    completeProviderEvidence(
      createAnalysisExecutionEvidence(
        "analyze_function",
        arguments_,
        {
          ...observation,
          sourceEvidence: sources,
          result: dossier.value,
          ...(observation.subject === undefined && target !== undefined
            ? { subject: target }
            : {}),
        },
        "observed",
      ),
      options?.signal,
    ),
    sources,
  );
};
