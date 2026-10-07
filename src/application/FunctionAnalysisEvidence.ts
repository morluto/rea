import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "./AnalysisProvider.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import { parseFunctionDossier } from "../domain/hopperValues.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";

/** Preserve the provider's observations when presenting a validated function dossier. */
export const executeFunctionAnalysisEvidence = async (
  analysis: AnalysisOperationPort,
  parameters: Readonly<Record<string, JsonValue>>,
  target: BinaryTarget | undefined,
  options?: ExecutionOptions,
) => {
  const input =
    toolContract("analyze_function").inputSchema.safeParse(parameters);
  if (!input.success)
    return err(
      new AnalysisInputError(
        "analyze_function",
        { cause: input.error },
        projectInputIssues(input.error.issues, parameters),
      ),
    );
  const arguments_ = jsonObjectSchema.parse(input.data);
  const execution = await analysis.execute(
    "analyze_function",
    arguments_,
    options,
  );
  if (!execution.ok) return execution;
  const dossier = parseFunctionDossier(execution.value.result);
  if (!dossier.ok) return dossier;
  const observation = execution.value;
  return ok(
    createEvidence(observation.subject ?? target, observation.provider, {
      operation: "analyze_function",
      parameters: arguments_,
      result: dossier.value,
      rawResult: observation.rawResult,
      limitations: observation.limitations,
      locations: observation.locations,
      ...(observation.analysisProfile === undefined
        ? {}
        : { analysisProfile: observation.analysisProfile }),
    }),
  );
};
