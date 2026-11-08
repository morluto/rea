import type { WebNetworkCapture } from "../../domain/webNetworkCapture.js";
import { setImmediate } from "node:timers/promises";
import { compareStaticObservedEndpointsRequestSchema } from "../../contracts/javascript/applicationWorkflowInputContracts.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { readImmutableEvidence } from "../../domain/evidenceValidation.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { EvidenceWorkflowExecution } from "../investigation/EvidenceWorkflowExecution.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { err, ok, type Result } from "../../domain/result.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import { WebNetworkApiSurfaceAccumulator } from "../../domain/analysisView/WebNetworkApiSurfaceAccumulator.js";
import { admitWebNetworkCaptureParent } from "../../domain/analysisView/WebNetworkProjectionAccumulator.js";
import { compareStaticObservedEndpoints } from "../../domain/javascript/staticObservedEndpoints.js";
import type { StaticObservedEndpointComparison } from "../../domain/javascript/staticObservedEndpointSchemas.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import {
  applicationGraphEvidenceInputError,
  parseApplicationGraphEvidence,
  type ApplicationGraphEvidenceSource,
} from "./JavaScriptApplicationEvidenceGraph.js";

const OPERATION = "compare_static_and_observed_endpoints";
interface EndpointComparisonExecution extends EvidenceWorkflowExecution {
  readonly result: StaticObservedEndpointComparison;
}

interface ComparisonSources {
  readonly application: ApplicationGraphEvidenceSource;
  readonly capture: WebNetworkCapture;
  readonly captureEvidence: Evidence;
  readonly origin: string | undefined;
}
type ComparisonOptions = { readonly signal?: AbortSignal };
type ComparisonFacts = Pick<
  StaticObservedEndpointComparison,
  "static_endpoints" | "observed_groups" | "matches" | "summary"
>;

const readSources = (
  rawInput: unknown,
  lookup: EvidenceLookup | undefined,
  accumulator: WebNetworkApiSurfaceAccumulator,
  options: ComparisonOptions,
): Result<ComparisonSources, AnalysisError> => {
  const request = resolveEvidenceRequest(
    OPERATION,
    rawInput,
    compareStaticObservedEndpointsRequestSchema,
    lookup,
    {
      ...options,
      readEvidence: (value) => {
        const admitted = accumulator.admitInlineEvidence(value);
        return admitted.ok ? readImmutableEvidence(value) : admitted;
      },
    },
  );
  if (!request.ok) return request;
  const input = request.value.input;
  const source = parseApplicationGraphEvidence(input.application, [
    "application",
  ]);
  if (!source.ok)
    return err(applicationGraphEvidenceInputError(OPERATION, source.error));
  if (source.value.kind !== "static-application")
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["application"],
          reason: "invalid_value",
          message:
            "Use analyze_javascript_application Evidence; reconciled, managed and web-bundle graphs are outside this comparison's static scope.",
        },
      ]),
    );
  const captureEvidence = input.capture;
  const admitted = admitWebNetworkCaptureParent(
    {
      evidenceId: captureEvidence.evidence_id,
      operation: captureEvidence.operation,
      predicateType: captureEvidence.predicate_type,
      normalizedResult: captureEvidence.normalized_result,
      subject: captureEvidence.subject,
      parameters: captureEvidence.parameters,
      limitations: captureEvidence.limitations,
    },
    "api-surface",
    accumulator,
    { operation: OPERATION, sourceField: "capture" },
  );
  if (!admitted.ok) return admitted;
  return ok({
    application: source.value,
    capture: admitted.value,
    captureEvidence,
    origin: input.origin,
  });
};

const sourceCoverage = (
  { application, capture, captureEvidence }: ComparisonSources,
  excluded: number,
): StaticObservedEndpointComparison["source_coverage"] => ({
  application: {
    status: application.graph.coverage.status,
    truncated: application.graph.coverage.truncated,
    omitted_count: application.graph.coverage.omitted_count,
    limit_count: application.graph.coverage.limits.length,
    limitation_count: new Set([
      ...application.evidence.limitations,
      ...application.graph.limitations,
    ]).size,
  },
  capture_limitation_count: new Set([
    ...captureEvidence.limitations,
    ...capture.limitations,
  ]).size,
  observed_records_examined: capture.records.length,
  observed_records_total: capture.total_records,
  observed_records_excluded: excluded,
});

const createComparison = (
  sources: ComparisonSources,
  comparison: ComparisonFacts,
  accumulator: WebNetworkApiSurfaceAccumulator,
): Result<EndpointComparisonExecution, AnalysisError> => {
  const { application, capture, captureEvidence, origin } = sources;
  const evidenceLinks = [
    application.evidence.evidence_id,
    captureEvidence.evidence_id,
  ].sort();
  const limitations = [
    "Source-specific limitation details remain on the two source Evidence records; source_coverage reports their counts without copying unrelated capture or graph text.",
    "Not-observed-in-capture refers only to this capture; it does not establish unused, hidden, inaccessible or absent server behavior.",
    "Template-compatible pairs are inferred format matches, not handler identity or runtime execution proof. Unknown static methods are never filled from observed methods.",
    "Observed-without-static-match means no confirmed correspondence in the supplied static observations; incomplete static discovery can miss code references.",
    ...(origin === undefined
      ? []
      : [
          "The origin for root-relative static targets is a caller assertion, not an observed application base URL.",
        ]),
  ].sort();
  const admittedLimitations = accumulator.addLimitations(limitations);
  if (!admittedLimitations.ok) return admittedLimitations;
  const parameters = {
    application_evidence_id: application.evidence.evidence_id,
    capture_evidence_id: captureEvidence.evidence_id,
    origin: origin ?? null,
  };
  const result: StaticObservedEndpointComparison = {
    comparison_id: `endpoint_comparison_${digestCanonicalValue(parameters)}`,
    application: {
      evidence_id: application.evidence.evidence_id,
      graph_id: application.graph.graph_id,
    },
    capture: {
      evidence_id: captureEvidence.evidence_id,
      artifact: {
        path: capture.artifact.path,
        sha256: capture.artifact.sha256,
      },
    },
    declared_origin: origin ?? null,
    ...comparison,
    source_coverage: sourceCoverage(
      sources,
      accumulator.comparisonCoverage().excluded_records,
    ),
    evidence_links: evidenceLinks,
    limitations,
  };
  const evidence: Evidence = createEvidence(
    undefined,
    JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
    {
      predicateType: "rea.static-observed-endpoint-comparison",
      operation: OPERATION,
      parameters,
      result,
      rawResult: null,
      confidence: "inferred",
      authority: "analyst-inference",
      environment: null,
      limitations,
      evidenceLinks,
    },
  );
  return ok({
    evidence,
    result,
    sources: [application.evidence, captureEvidence],
  });
};

/** Authenticate sources once, group cooperatively, then publish the completed comparison. */
export const compareStaticAndObservedEndpointsEvidence = async (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: ComparisonOptions = {},
): Promise<Result<EndpointComparisonExecution, AnalysisError>> => {
  const accumulator = new WebNetworkApiSurfaceAccumulator(undefined, false, {
    operation: OPERATION,
  });
  const admitted = readSources(rawInput, lookup, accumulator, options);
  if (!admitted.ok) return admitted;
  const sources = admitted.value;
  const { capture, captureEvidence } = sources;
  for (const [index, record] of capture.records.entries()) {
    if (index % 256 === 0) {
      await setImmediate();
      if (options.signal?.aborted)
        return err(
          new AnalysisCancelledError(OPERATION, {
            cause: options.signal.reason,
          }),
        );
    }
    const added = accumulator.add(record);
    if (!added.ok) return added;
  }
  const compared = compareStaticObservedEndpoints({
    applicationEvidenceId: sources.application.evidence.evidence_id,
    captureEvidenceId: captureEvidence.evidence_id,
    graph: sources.application.graph,
    accumulator,
    ...(sources.origin === undefined ? {} : { origin: sources.origin }),
    captureComplete: capture.records.length === capture.total_records,
  });
  if (!compared.ok) return compared;
  await setImmediate();
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
    );
  return createComparison(sources, compared.value, accumulator);
};
