import {
  artifactInventorySummaryViewResultSchema,
  sealAnalysisView,
} from "./analysisView.js";
import { ARTIFACT_INVENTORY_VIEW_CAVEATS } from "./artifactInventoryViewCaveats.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { evidenceSemanticContent, type Evidence } from "../evidence.js";

/** Exact shipped projections, rather than arbitrary omission or prose tolerance. */
export const artifactInventorySummaryProjectionIds = (
  current: Evidence,
): readonly string[] => {
  const result = artifactInventorySummaryViewResultSchema.parse(
    current.normalized_result,
  );
  const format = result.summary.manifest.root_format;
  if (
    format === "godot-pck" ||
    format === "pyinstaller" ||
    format === "node-sea"
  )
    return [current.evidence_id];
  const { view_digest: _digest, ...projection } = result;
  // b395190e4 began disclosing unavailable hashes for ordinary root formats.
  const beforeHashDisclosure = {
    ...projection,
    unknowns: projection.unknowns.filter(
      (value) => value !== ARTIFACT_INVENTORY_VIEW_CAVEATS.unknownContentHashes,
    ),
  };
  // ce1f4b1bb began carrying traversal coverage and its caveat for these roots.
  const { source_coverage: _coverage, ...summary } = projection.summary;
  const beforeTraversalDisclosure = {
    ...beforeHashDisclosure,
    summary,
    unknowns: beforeHashDisclosure.unknowns.filter(
      (value) => value !== ARTIFACT_INVENTORY_VIEW_CAVEATS.unknownTraversal,
    ),
  };
  return [
    current.evidence_id,
    ...[beforeHashDisclosure, beforeTraversalDisclosure].map(
      (variant) =>
        `ev_${digestCanonicalValue(
          evidenceSemanticContent({
            ...current,
            normalized_result: artifactInventorySummaryViewResultSchema.parse(
              sealAnalysisView(variant),
            ),
          }),
          "Evidence",
        )}`,
    ),
  ];
};
