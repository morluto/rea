import type { BinarySessionPort } from "./binary/BinarySessionPort.js";
import { EnhancedTools } from "./EnhancedTools.js";
import type { ValidatedEnhancedCall } from "./EnhancedToolTypes.js";
import { executeFunctionAnalysisEvidence } from "./FunctionAnalysisEvidence.js";
import { retainAnalysisResultSources } from "./investigation/recordEvidenceSources.js";
import {
  composedLimitationBudget,
  createWorkflowEvidence,
  executeComposedWorkflow,
  recordWorkflowUnknowns,
  retainComposedWorkflowSources,
  retainPartialWorkflowEvidence,
  workflowSnapshotRecord,
} from "./WorkflowEvidence.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "../ports/AnalysisProvider.js";

/**
 * The session records a provider-backed workflow reads and writes. Without a
 * session nothing is retained, recorded or replayed.
 */
export type WorkflowSession = Pick<
  BinarySessionPort,
  | "activeTarget"
  | "analysisProfile"
  | "recordEvidence"
  | "evidenceForAnalysis"
  | "admitRecoveryObservation"
  | "recordUnknown"
  | "allowsSnapshotReplay"
  | "recordWorkflowSnapshot"
>;

type WorkflowRequest = Required<Pick<ExecutionOptions, "signal" | "progress">>;

/** The parameters Evidence names: the caller's input without absent fields. */
const jsonParameters = (
  input: Readonly<Record<string, JsonValue | undefined>>,
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );

/**
 * Run one composed workflow on the admitted analysis and complete its
 * Evidence in the session: retain the sources it read (or its partial
 * Evidence when it stops), record the completed Evidence, its replayable
 * workflow snapshot and its residual unknowns. Every provider read reports
 * progress to the caller.
 */
export const executeSessionWorkflowEvidence = async (
  call: ValidatedEnhancedCall,
  admitted: AnalysisOperationPort,
  session: WorkflowSession | undefined,
  { signal, progress }: WorkflowRequest,
): Promise<Result<Evidence, AnalysisError>> => {
  const { name } = call;
  const parameters = jsonParameters(call.input);
  const analysis: AnalysisOperationPort = {
    resourceScope: admitted.resourceScope,
    execute: (operation, operationParameters, options) =>
      admitted.execute(operation, operationParameters, {
        ...options,
        progress,
      }),
  };
  const recordEvidence =
    session === undefined
      ? undefined
      : (evidence: Evidence) => session.recordEvidence(evidence);
  const evidenceInput = {
    target: session?.activeTarget(),
    operation: name,
    parameters,
    upstreamProfile:
      session === undefined
        ? undefined
        : (session.analysisProfile() ?? session.analysisProfile(name)),
  };
  const executed = await executeComposedWorkflow(
    analysis,
    (observed) => new EnhancedTools(observed).executeValidated(call, signal),
    composedLimitationBudget(name),
  );
  retainPartialWorkflowEvidence(executed, evidenceInput);
  const result = retainComposedWorkflowSources(
    recordEvidence,
    executed,
    evidenceInput,
    session === undefined ? undefined : (id) => session.evidenceForAnalysis(id),
    session === undefined
      ? undefined
      : (input, operation, additional) =>
          session.admitRecoveryObservation(input, operation, additional),
  );
  if (!result.ok) return result;
  const evidence = createWorkflowEvidence({
    ...evidenceInput,
    result: result.value.result,
    upstreamLimitations: result.value.limitations,
    ...(result.value.evidenceLinks === undefined
      ? {}
      : { upstreamEvidenceLinks: result.value.evidenceLinks }),
  });
  if (session === undefined) return ok(evidence);
  const recorded = session.recordEvidence(evidence);
  if (!recorded.ok) return recorded;
  if (name !== "trace_native_ui_action" && session.allowsSnapshotReplay(name)) {
    const workflowRecord = workflowSnapshotRecord(
      evidence,
      name,
      evidenceInput.upstreamProfile,
      result.value.cachePolicy,
    );
    if (workflowRecord !== undefined) {
      const snapshot = session.recordWorkflowSnapshot(workflowRecord);
      if (!snapshot.ok) return err(snapshot.error);
    }
  }
  const unknowns = recordWorkflowUnknowns({
    name,
    result: result.value.result,
    evidenceId: evidence.evidence_id,
    recordUnknown: (unknown) => session.recordUnknown(unknown),
    evidenceRetained: true,
  });
  return unknowns.ok ? ok(evidence) : unknowns;
};

/**
 * Analyze one function on the admitted analysis and retain the Evidence it
 * cites in the session.
 */
export const executeSessionFunctionAnalysis = async (
  input: Readonly<Record<string, JsonValue | undefined>>,
  analysis: AnalysisOperationPort,
  session: WorkflowSession | undefined,
  request: WorkflowRequest,
): Promise<Result<Evidence, AnalysisError>> =>
  retainAnalysisResultSources(
    "analyze_function",
    session === undefined
      ? undefined
      : (evidence) => session.recordEvidence(evidence),
    await executeFunctionAnalysisEvidence(
      analysis,
      jsonParameters(input),
      session?.activeTarget(),
      request,
    ),
  );
