import { bundleComparisonMcpInputSchema } from "../../contracts/sessionToolSchemas.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { compareBundles } from "../../domain/bundleComparison.js";
import { createEvidence } from "../../domain/evidence.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import { BUNDLE_COMPARISON_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok, type Result } from "../../domain/result.js";
import { unknownTarget } from "../../domain/targetIdentity.js";
import type { ArtifactResourceScope } from "../../resources/index.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { readComparisonEvidenceBundles } from "../EvidenceBundleFiles.js";
import type { InvestigationWorkflowExecution } from "./InvestigationWorkflows.js";

const OPERATION = "compare_bundles";

/** Both bundles a session comparison reads, and the pairs the caller declared. */
export interface BundleComparisonSources {
  readonly left: EvidenceBundle;
  readonly right: EvidenceBundle;
  readonly recordPairs: Parameters<typeof compareBundles>[2];
}

/**
 * Read both caller-named bundles under the resource scope. The bundle reader
 * opens and releases each file in that scope, which keeps a handle whose
 * release failed for a later cleanup retry.
 */
export const readBundleComparisonSources = async (
  input: unknown,
  options: {
    readonly signal: AbortSignal;
    readonly resources: ArtifactResourceScope;
  },
): Promise<Result<BundleComparisonSources, AnalysisError>> => {
  const request = parseAnalysisInput(
    OPERATION,
    input,
    bundleComparisonMcpInputSchema,
    options.signal,
  );
  if (!request.ok) return request;
  const loaded = await readComparisonEvidenceBundles(
    request.value.left_bundle_path,
    request.value.right_bundle_path,
    options.signal,
    options.resources,
    OPERATION,
  );
  if (!loaded.ok) return loaded;
  return ok({ ...loaded.value, recordPairs: request.value.record_pairs });
};

/**
 * Compare two bundles for a session. Every record of either bundle is a
 * source the session retains, and the derived Evidence links each one.
 */
export const bundleComparisonExecution = ({
  left,
  right,
  recordPairs,
}: BundleComparisonSources): Result<
  InvestigationWorkflowExecution,
  AnalysisError
> => {
  let comparison: ReturnType<typeof compareBundles>;
  try {
    comparison = compareBundles(left, right, recordPairs);
  } catch (cause: unknown) {
    // Missing or repeated record pairs are typed input failures.
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
  const sources = [
    ...new Map(
      [...left.records, ...right.records].map((record) => [
        record.evidence_id,
        record,
      ]),
    ).values(),
  ];
  const evidence = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    BUNDLE_COMPARISON_PROVIDER,
    {
      predicateType: "rea.bundle-comparison",
      operation: OPERATION,
      parameters: {
        left_bundle_sha256: comparison.left_bundle_sha256,
        right_bundle_sha256: comparison.right_bundle_sha256,
        record_pairs: recordPairs,
      },
      result: comparison,
      confidence: "derived",
      authority: "analyst-inference",
      limitations: comparison.limitations,
      evidenceLinks: sources.map(({ evidence_id }) => evidence_id),
    },
  );
  return ok({ evidence, sources, unknown: undefined });
};
