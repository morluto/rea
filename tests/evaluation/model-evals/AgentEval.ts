import {
  deliveredEvidence,
  evaluateKnownAnswers,
  type FixtureClaimExpectation,
  type KnownAnswerAssessment,
} from "./KnownAnswerEvaluation.js";
import type { AgentToolCall, AgentTranscript } from "./AgentTranscript.js";
import { canonicalJson } from "../../../src/domain/comparisonSemantics.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";

/** One REA MCP invocation measured in an agent transcript. */
interface AgentMcpCall {
  readonly id: string | null;
  readonly server: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  readonly evidenceIds: readonly string[];
  /** The client reported a completed result; an unreported result is unknown, not success. */
  readonly delivered: boolean;
  readonly error: boolean;
  readonly errorCode: string | null;
}

/** Transcript measurements, text heuristics, and optional closed fixture-claim assessment. */
export interface AgentMetrics {
  readonly naturalUse: boolean;
  readonly correctFirstTool: boolean;
  readonly firstTool: string | null;
  readonly reaCalls: readonly AgentMcpCall[];
  readonly repeatedCallCount: number;
  readonly inputValidationFailureCount: number;
  readonly requiredToolSubsequenceMet: boolean;
  /** Terminal failures the client reported for the run itself; any one fails the gate. */
  readonly clientFailures: readonly string[];
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly finalMessage: string;
  readonly evidenceIds: readonly string[];
  /** Whether the answer contains a produced Evidence ID; claim support is not checked. */
  readonly finalCitesEvidence: boolean;
  /** Case-insensitive substring coverage, including terms in negated claims. */
  readonly answerTermCoverageMet: boolean;
  /** Text length, term/cue coverage, and configured transcript checks only. */
  readonly answerHeuristicsMet: boolean;
  /** Whether an epistemic keyword occurs; this does not establish honest authority use. */
  readonly epistemicCuePresent: boolean;
  /** Limited to configured fixture claims; free-form factual correctness is not assessed. */
  readonly factualCorrectness: KnownAnswerAssessment["status"];
  readonly factualAssessment: KnownAnswerAssessment;
}

const measuredCall = (call: AgentToolCall): AgentMcpCall => ({
  id: call.id,
  server: call.server,
  tool: call.tool,
  arguments: call.arguments,
  evidenceIds: deliveredEvidence(call).map(({ evidence_id }) => evidence_id),
  delivered: call.delivered,
  error: call.error,
  errorCode: call.errorCode,
});

/** Identical calls beyond the first, with status reads keyed by target lifecycle. */
const countRepeatedCalls = (calls: readonly AgentMcpCall[]): number => {
  const signatures = new Map<string, number>();
  let targetRevision = 0;
  for (const call of calls) {
    // A status read before and after a successful target lifecycle change is
    // useful verification, not a duplicate analysis or unchanged failed retry.
    const context =
      call.tool === "binary_session" ? `${String(targetRevision)}:` : "";
    const signature = `${context}${call.tool}:${canonicalJson(call.arguments)}`;
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
    if (
      call.delivered &&
      !call.error &&
      (call.tool === "open_binary" || call.tool === "close_binary")
    )
      targetRevision += 1;
  }
  return [...signatures.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
};

/** Measure agent routing, repetition, model usage, and explicitly limited answer heuristics. */
export const evaluateAgentTranscript = (
  transcript: AgentTranscript,
  expectedFirstTool: string | null,
  options: {
    readonly requireEvidence?: boolean;
    readonly requiredAnswerTermGroups?: readonly (readonly string[])[];
    readonly requiredToolSubsequence?: readonly string[];
    readonly forbidInputValidationFailures?: boolean;
    readonly fixtureClaims?: readonly FixtureClaimExpectation[];
  } = {},
): AgentMetrics => {
  const reaCalls = transcript.calls
    .filter(({ server }) => server?.toLowerCase() === "rea")
    .map(measuredCall);
  const repeatedCallCount = countRepeatedCalls(reaCalls);
  const inputValidationFailureCount = reaCalls.filter(
    (call) =>
      call.errorCode === "invalid_request" ||
      (call.error &&
        TOOL_CONTRACTS.find(
          ({ name }) => name === call.tool,
        )?.inputSchema.safeParse(call.arguments).success === false),
  ).length;
  const requiredToolSubsequenceMet = containsOrderedSubsequence(
    completedTools(reaCalls),
    options.requiredToolSubsequence ?? [],
  );
  const { finalMessage, clientFailures } = transcript;
  const evidenceIds = [
    ...new Set(reaCalls.flatMap(({ evidenceIds: ids }) => ids)),
  ];
  const finalCitesEvidence = evidenceIds.some((evidenceId) =>
    finalMessage.includes(evidenceId),
  );
  const normalizedFinalMessage = finalMessage.toLocaleLowerCase("en-US");
  const answerTermCoverageMet = (options.requiredAnswerTermGroups ?? []).every(
    (terms) =>
      terms.some((term) =>
        normalizedFinalMessage.includes(term.toLocaleLowerCase("en-US")),
      ),
  );
  const epistemicCuePresent =
    /\b(evidence|observed|inferred|unknown|unavailable|limitation|authority|not configured|could not|requires approval)\b/iu.test(
      finalMessage,
    );
  const factualAssessment = evaluateKnownAnswers(
    transcript.calls,
    finalMessage,
    options.fixtureClaims,
  );
  return {
    naturalUse: reaCalls.length > 0,
    correctFirstTool: (reaCalls[0]?.tool ?? null) === expectedFirstTool,
    firstTool: reaCalls[0]?.tool ?? null,
    reaCalls,
    repeatedCallCount,
    inputValidationFailureCount,
    requiredToolSubsequenceMet,
    clientFailures,
    ...transcript.usage,
    finalMessage,
    evidenceIds,
    finalCitesEvidence,
    answerTermCoverageMet,
    answerHeuristicsMet:
      finalMessage.trim().length >= 80 &&
      epistemicCuePresent &&
      answerTermCoverageMet &&
      requiredToolSubsequenceMet &&
      clientFailures.length === 0 &&
      (options.forbidInputValidationFailures !== true ||
        inputValidationFailureCount === 0) &&
      (options.requireEvidence !== true || finalCitesEvidence),
    epistemicCuePresent,
    factualCorrectness: factualAssessment.status,
    factualAssessment,
  };
};

/** Tools whose results were delivered without error, in call order. */
const completedTools = (calls: readonly AgentMcpCall[]): string[] =>
  calls
    .filter(({ delivered, error }) => delivered && !error)
    .map(({ tool }) => tool);

const containsOrderedSubsequence = (
  values: readonly string[],
  required: readonly string[],
): boolean => {
  let index = 0;
  for (const value of values) {
    if (value === required[index]) index += 1;
    if (index === required.length) return true;
  }
  return required.length === 0;
};
