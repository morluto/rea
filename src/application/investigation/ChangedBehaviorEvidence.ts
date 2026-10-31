import { readChangedBehaviorSelection } from "../../domain/changedBehavior.js";
import { retainedEvidenceReferenceSchema } from "../../domain/evidenceReference.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";

/** Resolve exact selected identities; the domain still owns full-record authentication. */
export const resolveChangedBehaviorEvidence = (
  input: unknown,
  lookup: EvidenceLookup | undefined,
): Result<{ readonly comparisons: readonly unknown[] }, AnalysisError> => {
  const selection = readChangedBehaviorSelection(input);
  if (!selection.ok) return selection;
  const comparisons: unknown[] = [];
  for (const [index, item] of selection.value.entries()) {
    if (typeof item !== "object" || item === null || !("kind" in item)) {
      comparisons.push(item);
      continue;
    }
    const reference = retainedEvidenceReferenceSchema.safeParse(item);
    if (!reference.success)
      return err(
        analysisInputErrorFromIssues(
          "find_changed_behavior",
          reference.error.issues.map((issue) => ({
            ...issue,
            path: ["comparisons", index, ...issue.path],
          })),
          input,
          { cause: reference.error },
        ),
      );
    const resolved = resolveEvidenceInput(reference.data, lookup);
    if (!resolved.ok) return resolved;
    comparisons.push(resolved.value);
  }
  return ok({ comparisons });
};
