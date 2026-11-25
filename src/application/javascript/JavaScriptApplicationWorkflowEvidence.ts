import { unknownTarget } from "../../domain/targetIdentity.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
  type EvidenceSubjectTarget,
} from "../../domain/evidence.js";
import type { ApplicationVersionComparisonResult } from "../../domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import type { JavaScriptExportShapeComparisonResult } from "../../domain/javascript/javascriptExportShapeComparisonSchemas.js";
import type { ApplicationFeatureTraceResult } from "../../domain/javascript/javascriptFeatureTraceSchemas.js";
import type { JavaScriptSemanticTraceResult } from "../../domain/javascript/javascriptSemanticTraceSchemas.js";
import type { SourceToBundleComparisonResult } from "../../domain/javascript/sourceToBundleComparisonSchemas.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";

const workflowEvidence = (
  predicateType: string,
  operation: string,
  parameters: EvidenceObservation["parameters"],
  result: {
    readonly limitations: readonly string[];
    readonly evidence_links: readonly string[];
  },
  subject?: EvidenceSubjectTarget,
): Evidence =>
  createEvidence(
    subject ?? unknownTarget("derived-from-linked-evidence"),
    JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
    {
      predicateType,
      operation,
      parameters,
      result,
      rawResult: null,
      confidence: "inferred",
      authority: "analyst-inference",
      environment: null,
      limitations: result.limitations,
      evidenceLinks: result.evidence_links,
    },
  );

/** Create derived Evidence for one bounded application-graph feature trace. */
export const createApplicationFeatureTraceEvidence = (
  subject: EvidenceSubjectTarget | undefined,
  parameters: EvidenceObservation["parameters"],
  result: ApplicationFeatureTraceResult,
): Evidence =>
  workflowEvidence(
    "rea.application-feature-trace",
    "trace_application_feature",
    parameters,
    result,
    subject,
  );

/** Create derived Evidence for one bounded JavaScript semantic trace. */
export const createJavaScriptSemanticTraceEvidence = (
  subject: EvidenceSubjectTarget | undefined,
  parameters: EvidenceObservation["parameters"],
  result: JavaScriptSemanticTraceResult,
): Evidence =>
  workflowEvidence(
    "rea.javascript-semantic-trace",
    "trace_javascript_semantics",
    parameters,
    result,
    subject,
  );

/** Create derived Evidence for one tiered application version comparison. */
export const createApplicationVersionComparisonEvidence = (
  parameters: EvidenceObservation["parameters"],
  result: ApplicationVersionComparisonResult,
): Evidence =>
  workflowEvidence(
    "rea.application-version-comparison",
    "compare_application_versions",
    parameters,
    result,
  );

/** Create derived Evidence for one historical-source to bundle comparison. */
export const createSourceToBundleComparisonEvidence = (
  parameters: EvidenceObservation["parameters"],
  result: SourceToBundleComparisonResult,
): Evidence =>
  workflowEvidence(
    "rea.source-to-bundle-comparison",
    "compare_source_to_bundle",
    parameters,
    result,
  );

/** Create derived Evidence for one bounded static export-shape comparison. */
export const createJavaScriptExportShapeComparisonEvidence = (
  parameters: EvidenceObservation["parameters"],
  result: JavaScriptExportShapeComparisonResult,
): Evidence =>
  workflowEvidence(
    "rea.javascript-export-shape-comparison",
    "compare_javascript_export_shapes",
    parameters,
    result,
  );
