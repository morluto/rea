import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type {
  RecordUnknownInput,
  UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import type { ProviderIdentity } from "./AnalysisProvider.js";

/** Provider identity for analyst-authored residual-unknown mutations. */
export const UNKNOWN_REGISTRY_PROVIDER: ProviderIdentity = {
  id: "rea-unknown-registry",
  name: "REA residual unknown registry",
  version: "1",
};

/** Create immutable evidence for one approved residual-unknown mutation. */
export const unknownMutationEvidence = (
  target: BinaryTarget | undefined,
  input: RecordUnknownInput,
): Evidence =>
  createEvidence(target, UNKNOWN_REGISTRY_PROVIDER, {
    predicateType: "rea.residual-unknown-mutation/v1",
    operation: "record_unknown",
    parameters: { domain: input.domain, severity: input.severity },
    result: {
      action: "record",
      question: input.question,
      required_authority: input.required_authority,
      required_confidence: input.required_confidence,
    },
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: unknownEvidenceLinks(input),
    limitations: [
      "Registry mutation evidence records analyst intent, not proof of the answer.",
    ],
  });

/** Deduplicate evidence links carried by an unknown mutation. */
export const unknownEvidenceLinks = (
  input: RecordUnknownInput | UpdateUnknownInput,
): string[] =>
  [
    ...input.supporting_evidence_ids,
    ...input.contradicting_evidence_ids,
    ...("resolution" in input && input.resolution !== null
      ? input.resolution.evidence_ids
      : []),
  ].filter((id, index, values) => values.indexOf(id) === index);
