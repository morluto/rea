import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import type { ApplicationVersionComparisonResult } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import type { JavaScriptExportShapeComparisonResult } from "../domain/javascriptExportShapeComparisonSchemas.js";
import type { ApplicationFeatureTraceResult } from "../domain/javascriptFeatureTraceSchemas.js";
import type { JavaScriptSemanticTraceResult } from "../domain/javascriptSemanticTraceSchemas.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";

/** Create derived Evidence for one bounded application-graph feature trace. */
export const createApplicationFeatureTraceEvidence = (
  parameters: EvidenceObservation["parameters"],
  result: ApplicationFeatureTraceResult,
): Evidence =>
  createEvidence(undefined, JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, {
    predicateType: "rea.application-feature-trace/v1",
    operation: "trace_application_feature",
    parameters,
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });

/** Create derived Evidence for one bounded JavaScript semantic trace. */
export const createJavaScriptSemanticTraceEvidence = (
  parameters: EvidenceObservation["parameters"],
  result: JavaScriptSemanticTraceResult,
): Evidence =>
  createEvidence(undefined, JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, {
    predicateType: "rea.javascript-semantic-trace/v1",
    operation: "trace_javascript_semantics",
    parameters,
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });

/** Create derived Evidence for one tiered application version comparison. */
export const createApplicationVersionComparisonEvidence = (
  parameters: EvidenceObservation["parameters"],
  result: ApplicationVersionComparisonResult,
): Evidence =>
  createEvidence(undefined, JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, {
    predicateType: "rea.application-version-comparison/v1",
    operation: "compare_application_versions",
    parameters,
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });

/** Create derived Evidence for one bounded static export-shape comparison. */
export const createJavaScriptExportShapeComparisonEvidence = (
  parameters: EvidenceObservation["parameters"],
  result: JavaScriptExportShapeComparisonResult,
): Evidence =>
  createEvidence(undefined, JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, {
    predicateType: "rea.javascript-export-shape-comparison/v1",
    operation: "compare_javascript_export_shapes",
    parameters,
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });
