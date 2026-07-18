import {
  digestJson,
  type PreparedReplayPlan,
} from "../application/JavaScriptReplayPlanning.js";
import type { ReplayExecutionResult } from "../domain/javascriptReplay.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { WorkerProtocolOutcome } from "./ReplayWorkerProtocol.js";

export const workerRequest = (prepared: PreparedReplayPlan) => ({
  schemaVersion: 1,
  left: workerSide(prepared.publicPlan.left, prepared.leftSources),
  ...(prepared.publicPlan.right === undefined ||
  prepared.rightSources === undefined
    ? {}
    : { right: workerSide(prepared.publicPlan.right, prepared.rightSources) }),
  cases: prepared.publicPlan.cases.map((item) => ({
    caseId: item.case_id,
    arguments: item.arguments,
    inputSha256: item.sha256,
  })),
  determinism: {
    clockIso: prepared.publicPlan.determinism.clock_iso,
    randomSeed: prepared.publicPlan.determinism.random_seed,
  },
  limits: {
    resultDepth: prepared.publicPlan.limits.result_depth,
    resultNodes: prepared.publicPlan.limits.result_nodes,
    exceptionBytes: Math.min(
      64 * 1024,
      prepared.publicPlan.limits.output_bytes,
    ),
  },
});

const workerSide = (
  side: PreparedReplayPlan["publicPlan"]["left"],
  sources: Readonly<Record<string, string>>,
) => ({
  modules: side.modules.map((module) => ({
    alias: module.alias,
    format: module.format,
    dependencies: module.dependencies,
    source: sources[module.alias] ?? "",
  })),
  entryAlias: side.entry_alias,
  entryExport: side.entry_export,
});

export const commitOutcomes = (
  outcomes: readonly WorkerProtocolOutcome[],
): ReplayExecutionResult["outcomes"] =>
  outcomes.map((outcome) => {
    const semantic =
      outcome.value === undefined ? (outcome.exception ?? null) : outcome.value;
    return {
      case_id: outcome.case_id,
      outcome: outcome.outcome,
      ...(outcome.value === undefined
        ? {}
        : { value: jsonValueSchema.parse(outcome.value) }),
      ...(outcome.exception === undefined
        ? {}
        : { exception: outcome.exception }),
      input_sha256: outcome.input_sha256,
      output_sha256: digestJson(semantic),
      truncated: false,
    };
  });

export const compareOutcomes = (
  left: ReplayExecutionResult["outcomes"],
  right: ReplayExecutionResult["outcomes"],
): NonNullable<ReplayExecutionResult["comparison"]> =>
  left.map((item, index) => ({
    case_id: item.case_id,
    status:
      right[index] === undefined
        ? "unknown"
        : item.outcome === right[index].outcome &&
            item.output_sha256 === right[index].output_sha256
          ? "equal"
          : "changed",
    left_index: index,
    right_index: index,
  }));

export interface TerminationResultOptions {
  readonly prepared: PreparedReplayPlan;
  readonly stderr: string;
  readonly termination:
    | "timeout"
    | "oom"
    | "crash"
    | "cancelled"
    | "protocol_error";
  readonly cleanup: ReplayExecutionResult["cleanup"];
  readonly limitation?: string;
}

export const terminationResult = (
  options: TerminationResultOptions,
): ReplayExecutionResult => {
  const { prepared, stderr, termination, cleanup, limitation } = options;
  const outcomes = prepared.publicPlan.cases.map((item) => ({
    case_id: item.case_id,
    outcome: termination,
    input_sha256: item.sha256,
    output_sha256: null,
    truncated: termination === "protocol_error",
  }));
  const differential = prepared.publicPlan.right !== undefined;
  return {
    schema_version: 1,
    plan_digest: prepared.publicPlan.plan_digest,
    outcomes: [...outcomes, ...(differential ? outcomes : [])],
    ...(differential
      ? {
          comparison: outcomes.map((item, index) => ({
            case_id: item.case_id,
            status: "unknown" as const,
            left_index: index,
            right_index: index,
          })),
        }
      : {}),
    stderr,
    termination,
    cleanup,
    limitations: [
      limitation ??
        `Replay terminated with ${termination}; the requested functional result remains unknown.`,
    ],
    reproducer: null,
  };
};
