import type { ProviderSelectionProvenance } from "../../domain/evidence.js";
import type {
  AnalysisProviderCandidateStatus,
  AnalysisProviderSelectionSource,
} from "./AnalysisProviderRegistry.js";
import type { SessionProviderRoute } from "./SessionProviderRouter.js";

/**
 * Project the canonical selection model onto Evidence provenance. Only facts
 * already exposed through `binary_session` are retained: the source of the
 * choice, every evaluated candidate, its selection state and the stable codes
 * that excluded it. Diagnostics, remediation prose and target content stay in
 * the session status projection and are not copied into every record.
 */
export const providerSelectionProvenance = (
  selectionSource: AnalysisProviderSelectionSource,
  candidates: readonly AnalysisProviderCandidateStatus[],
): ProviderSelectionProvenance => ({
  selection_source: selectionSource,
  candidates: candidates.map((candidate) => ({
    provider: {
      id: candidate.provider.id,
      name: candidate.provider.name,
      version: candidate.provider.version,
    },
    selected: candidate.selected,
    availability: candidate.availability.status,
    target_support: candidate.targetSupport.status,
    rejection_codes: [...new Set(candidate.rejections.map(({ code }) => code))],
  })),
});

/** Selection provenance observable from one parsed session route, if it bound a provider. */
export const selectionProvenanceForRoute = (
  route: SessionProviderRoute,
): ProviderSelectionProvenance | undefined => {
  const binding = route.binding;
  if (binding === null) return undefined;
  return providerSelectionProvenance(
    binding.selectionSource,
    route.selection?.candidates ?? [],
  );
};
