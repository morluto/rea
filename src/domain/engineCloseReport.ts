import { z } from "zod";

import type {
  AnalysisError,
  AnalysisPartialObservation,
} from "./analysisErrorBase.js";
import { err, type Result } from "./result.js";
import type { SavedAnalysisSnapshot } from "./savedAnalysisSnapshot.js";

/**
 * Engine state a successful close released without persisting it. A Ghidra
 * checkpoint session whose save another session superseded keeps its Program
 * edits until the next close, which releases them unsaved.
 */
export const discardedCheckpointEditsSchema = z
  .strictObject({
    status: z.literal("discarded"),
    reason: z
      .literal("superseded")
      .describe(
        "Another session published this target's checkpoint first, so the save was refused.",
      ),
    directory: z
      .string()
      .min(1)
      .describe("Checkpoint directory whose current generation is unchanged."),
  })
  .describe(
    "This session's Program edits were released unsaved; reopen the target and reapply them to the current checkpoint.",
  );

export type DiscardedCheckpointEdits = z.infer<
  typeof discardedCheckpointEditsSchema
>;

/**
 * What a successful engine close reports beyond releasing its resources. A
 * type alias, not an interface, so the JSON result contract accepts it.
 */
export type EngineCloseReport = {
  readonly checkpoint: DiscardedCheckpointEdits;
};

/** A snapshot saved before the close, with what that close released unsaved. */
export type ClosedWithSnapshot = SavedAnalysisSnapshot &
  Partial<EngineCloseReport>;

/** Every value a successful close returns. */
export type CloseValue = EngineCloseReport | ClosedWithSnapshot | null;

/**
 * Facts a close completed before a later step of it failed: a published
 * snapshot and engine state released unsaved. Both stay true after the
 * failure, so the failure carries them as its partial observation.
 */
export interface CloseOutcomePartialObservation {
  readonly saved_snapshot?: SavedAnalysisSnapshot;
  readonly checkpoint?: DiscardedCheckpointEdits;
  /** The failing cleanup producer's own observation, kept beside them. */
  readonly cleanup_observation?: AnalysisPartialObservation;
}

type CloseFacts = Pick<
  CloseOutcomePartialObservation,
  "saved_snapshot" | "checkpoint"
>;

const isCloseOutcome = (
  observation: AnalysisPartialObservation | undefined,
): observation is CloseOutcomePartialObservation =>
  typeof observation === "object" &&
  observation !== null &&
  !("kind" in observation) &&
  ("saved_snapshot" in observation || "checkpoint" in observation);

const factsOfValue = (value: CloseValue): CloseFacts => {
  if (value === null) return {};
  const { checkpoint, ...rest } = value;
  return {
    ...("path" in rest ? { saved_snapshot: rest } : {}),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
};

const observationOf = (
  outcome: Result<CloseValue, AnalysisError>,
): CloseOutcomePartialObservation => {
  if (outcome.ok) return factsOfValue(outcome.value);
  const observation = outcome.error.partialObservation;
  if (observation === undefined) return {};
  return isCloseOutcome(observation)
    ? observation
    : { cleanup_observation: observation };
};

/**
 * Attach completed close facts to the failure that ends that close. This is
 * the one composition point for them: every owner that turns a released
 * engine or a published snapshot into a failure calls it on its outermost
 * error, with the outcomes it composed, so composing errors cannot drop
 * them. A failed outcome also contributes its producer's own observation.
 * Facts already attached win.
 */
export const retainCloseOutcome = <Failure extends AnalysisError>(
  error: Failure,
  ...sources: readonly (CloseFacts | null | Result<CloseValue, AnalysisError>)[]
): Failure => {
  let { saved_snapshot, checkpoint, cleanup_observation } = observationOf(
    err(error),
  );
  for (const source of sources) {
    if (source === null) continue;
    const facts: CloseOutcomePartialObservation =
      "ok" in source ? observationOf(source) : source;
    saved_snapshot ??= facts.saved_snapshot;
    checkpoint ??= facts.checkpoint;
    cleanup_observation ??= facts.cleanup_observation;
  }
  if (saved_snapshot === undefined && checkpoint === undefined) return error;
  error.partialObservation = Object.freeze({
    ...(saved_snapshot === undefined
      ? {}
      : { saved_snapshot: Object.freeze({ ...saved_snapshot }) }),
    ...(checkpoint === undefined
      ? {}
      : { checkpoint: Object.freeze({ ...checkpoint }) }),
    ...(cleanup_observation === undefined ? {} : { cleanup_observation }),
  });
  return error;
};

/** The engine report among close outcomes; one close releases at most one engine's edits. */
export const engineCloseReportOf = (
  ...outcomes: readonly Result<CloseValue, AnalysisError>[]
): EngineCloseReport | null => {
  for (const outcome of outcomes) {
    const { checkpoint } = observationOf(outcome);
    if (checkpoint !== undefined) return { checkpoint };
  }
  return null;
};
