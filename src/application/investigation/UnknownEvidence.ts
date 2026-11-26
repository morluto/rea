import { unknownTarget } from "../../domain/targetIdentity.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import {
  createEvidence,
  evidenceEnvelopeForAdmission,
  withEvidenceProviderSelection,
  type Evidence,
  type EvidenceObservationInput,
  type ProviderSelectionProvenance,
} from "../../domain/evidence.js";
import type {
  RecordUnknownInput,
  UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import type { ProviderIdentity } from "../../ports/AnalysisProvider.js";

/** Provider identity for analyst-authored residual-unknown mutations. */
const UNKNOWN_REGISTRY_PROVIDER: ProviderIdentity = {
  id: "rea-unknown-registry",
  name: "REA residual unknown registry",
  version: "1",
};

type UnknownMutation =
  | { readonly operation: "record_unknown"; readonly input: RecordUnknownInput }
  | {
      readonly operation: "update_unknown";
      readonly input: UpdateUnknownInput;
    };

/** Borrow mutation fields for admission without copying or hashing their payloads. */
const mutationObservation = (
  mutation: UnknownMutation,
  evidenceLinks = unknownEvidenceLinks(mutation.input),
): EvidenceObservationInput => ({
  predicateType: "rea.residual-unknown-mutation",
  operation: mutation.operation,
  parameters: mutation.input,
  result:
    mutation.operation === "record_unknown"
      ? {
          action: "record",
          question: mutation.input.question,
          required_authority: mutation.input.required_authority,
          required_confidence: mutation.input.required_confidence,
        }
      : { action: "update", status: mutation.input.status },
  confidence: "derived",
  authority: "analyst-inference",
  evidenceLinks,
  limitations: [
    "Registry mutation evidence records analyst intent, not proof of the answer.",
  ],
});

/** The same expanded representation, borrowed before materialization. */
export const unknownMutationEnvelope = (
  target: BinaryTarget | undefined,
  mutation: UnknownMutation,
  providerSelection?: ProviderSelectionProvenance,
) => ({
  ...evidenceEnvelopeForAdmission(
    target ?? unknownTarget("not-observed"),
    UNKNOWN_REGISTRY_PROVIDER,
    mutationObservation(mutation, []),
  ),
  // Separate borrowed lists conservatively include duplicates without allocating
  // the deduplicated output before admission.
  evidence_links: [
    mutation.input.supporting_evidence_ids,
    mutation.input.contradicting_evidence_ids,
    "resolution" in mutation.input
      ? (mutation.input.resolution?.evidence_ids ?? [])
      : [],
  ],
  ...(providerSelection === undefined
    ? {}
    : { provider_selection: providerSelection }),
});

/** Create immutable evidence only after the expanded envelope has been admitted. */
export const unknownMutationEvidence = (
  target: BinaryTarget | undefined,
  mutation: UnknownMutation,
  providerSelection?: ProviderSelectionProvenance,
): Evidence =>
  withEvidenceProviderSelection(
    createEvidence(
      target ?? unknownTarget("not-observed"),
      UNKNOWN_REGISTRY_PROVIDER,
      mutationObservation(mutation),
    ),
    providerSelection,
  );

/** Deduplicate evidence links carried by an unknown mutation. */
const unknownEvidenceLinks = (
  input: RecordUnknownInput | UpdateUnknownInput,
): string[] => [
  ...new Set([
    ...input.supporting_evidence_ids,
    ...input.contradicting_evidence_ids,
    ...("resolution" in input && input.resolution !== null
      ? input.resolution.evidence_ids
      : []),
  ]),
];
