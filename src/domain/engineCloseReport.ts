import { z } from "zod";

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

/** Keep the first report: one close releases at most one engine's edits. */
export const mergeEngineCloseReports = (
  reports: readonly (EngineCloseReport | null)[],
): EngineCloseReport | null =>
  reports.find((report) => report !== null) ?? null;
