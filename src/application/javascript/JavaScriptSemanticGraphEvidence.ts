import type { ApplicationGraphEvidence } from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JsonValue } from "../../domain/jsonValue.js";

const INFERENCE_LIMITATION =
  "This relationship is a conservative static candidate; it does not prove runtime execution or causal flow.";

/** Exact artifact-backed syntax evidence for one semantic graph node. */
export const observedSemanticEvidence = (
  file: JavaScriptArtifactFile,
  location: JavaScriptSourceRange | null,
): ApplicationGraphEvidence => ({
  authority: "ast-static-analysis",
  state: "observed",
  confidence: "exact",
  artifact: {
    available: true,
    artifact_id: `art_${file.sha256}`,
    sha256: file.sha256,
  },
  location:
    location === null
      ? { available: true, value: { kind: "artifact-path", path: file.path } }
      : {
          available: true,
          value: { kind: "source-range", source: file.path, ...location },
        },
  extractor: {
    name: "rea-javascript-semantic-analysis",
    version: "1",
    operation: "analyze_javascript_application",
    executable_sha256: null,
  },
  coverage: {
    status: "complete",
    truncated: false,
    omitted_count: 0,
    limits: [],
  },
  limitations: [],
  evidence_ids: [],
});

/** Conservative static relationship evidence derived from one syntax node. */
export const inferredSemanticEvidence = (
  source: ApplicationGraphEvidence,
): ApplicationGraphEvidence => ({
  ...source,
  authority: "static-relationship-inference",
  state: "inferred",
  confidence: "high",
  limitations: [INFERENCE_LIMITATION],
});

/** Static relationship evidence anchored at the syntax that proves the link. */
export const inferredSemanticEvidenceAt = (
  file: JavaScriptArtifactFile,
  location: JavaScriptSourceRange,
): ApplicationGraphEvidence => ({
  ...observedSemanticEvidence(file, location),
  authority: "static-relationship-inference",
  state: "inferred",
  confidence: "high",
  limitations: [INFERENCE_LIMITATION],
});

/** A built-in operation whose identity is conditional on loader or mutation facts. */
export const candidateBuiltinSemanticEvidence = (
  file: JavaScriptArtifactFile,
  location: JavaScriptSourceRange,
): ApplicationGraphEvidence => {
  const evidence = inferredSemanticEvidenceAt(file, location);
  return {
    ...evidence,
    confidence: "low",
    limitations: [
      ...evidence.limitations,
      "The built-in identity or its mutation state is unproven; this operation is conditional.",
    ],
  };
};

type SemanticBuiltinOperation = {
  readonly builtinAuthority?: "candidate" | undefined;
  readonly location: JavaScriptSourceRange;
};

/** Keep the candidate marker and its Evidence together on built-in nodes. */
export const builtinSemanticNode = (
  file: JavaScriptArtifactFile,
  operation: SemanticBuiltinOperation,
  properties: Readonly<Record<string, JsonValue>>,
): {
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly evidence?: ApplicationGraphEvidence;
} =>
  operation.builtinAuthority === "candidate"
    ? {
        evidence: candidateBuiltinSemanticEvidence(file, operation.location),
        properties: { ...properties, builtin_authority: "candidate" },
      }
    : { properties };

/** Keep conditional built-in authority and relation resolution together. */
export const builtinSemanticRelation = (
  file: JavaScriptArtifactFile,
  operation: SemanticBuiltinOperation,
  resolution: "resolved" | "candidate",
): {
  readonly resolution: "resolved" | "candidate";
  readonly evidence?: ApplicationGraphEvidence;
} =>
  operation.builtinAuthority === "candidate"
    ? {
        resolution: "candidate",
        evidence: candidateBuiltinSemanticEvidence(file, operation.location),
      }
    : { resolution };

/** Explicit absence of semantic syntax for an artifact-level fallback root. */
export const unavailableSemanticRootEvidence = (
  rootArtifactSha256: string,
): ApplicationGraphEvidence => ({
  authority: "unknown",
  state: "unavailable",
  confidence: "unknown",
  artifact: {
    available: true,
    artifact_id: `art_${rootArtifactSha256}`,
    sha256: rootArtifactSha256,
  },
  location: {
    available: false,
    reason: "not-observed",
    detail: "No admitted JavaScript source produced semantic IR.",
  },
  extractor: {
    name: "rea-javascript-semantic-analysis",
    version: "1",
    operation: "analyze_javascript_application",
    executable_sha256: null,
  },
  coverage: {
    status: "unavailable",
    truncated: false,
    omitted_count: null,
    limits: [],
  },
  limitations: ["This synthetic graph root does not claim a source location."],
  evidence_ids: [],
});

/** Explicit unknown evidence at one unresolved dynamic syntax location. */
export const unknownSemanticEvidence = (
  file: JavaScriptArtifactFile,
  location: JavaScriptSourceRange | null,
): ApplicationGraphEvidence => ({
  ...observedSemanticEvidence(file, location),
  authority: "unknown",
  state: "unknown",
  confidence: "unknown",
  limitations: ["Dynamic syntax prevents an exact static relationship."],
});
