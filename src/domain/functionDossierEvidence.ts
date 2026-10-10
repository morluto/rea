import { parseEvidence, type Evidence } from "./evidence.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { functionDossierSchema, type FunctionDossier } from "./hopperValues.js";

/** Complete function observation parsed from one analyze_function Evidence record. */
export interface FunctionSnapshot {
  readonly evidence: Evidence;
  readonly subject: NonNullable<Evidence["subject"]>;
  readonly dossier: FunctionDossier;
  readonly limitations: readonly string[];
}

/** Parse one complete analyze_function Evidence record for comparison workflows. */
export const parseFunctionEvidence = (input: unknown): FunctionSnapshot => {
  const evidence = parseEvidence(input);
  if (evidence.operation !== "analyze_function")
    throw new TypeError(
      "Function comparison requires analyze_function Evidence",
    );
  if (evidence.subject === null)
    throw new TypeError("Function comparison requires artifact-bound Evidence");
  const dossier = functionDossierSchema.parse(evidence.normalized_result);
  return {
    evidence,
    subject: evidence.subject,
    dossier,
    limitations: [
      ...new Set([...evidence.limitations, ...dossier.limitations]),
    ].sort((left, right) => compareUnicodeCodePoints(left, right)),
  };
};
