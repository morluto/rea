import type { WebPageInspection } from "./browserObservation.js";
import {
  webBundleAnalysisSchema,
  type WebBundleAnalysis,
} from "./webBundleAnalysis.js";
import type { AnalysisAccumulator, IncludedScript } from "./webBundleAnalyzerInspection.js";

export const buildWebBundleAnalysis = (
  inspection: WebPageInspection,
  sourceScripts: IncludedScript[],
  sourceMaps: WebBundleAnalysis["observations"]["source_maps"],
  accumulator: AnalysisAccumulator,
): WebBundleAnalysis => {
  const unavailable = inspection.scripts.items
    .filter((script) => !script.source.included)
    .map(({ script_key }) => script_key);
  const sourceMapIncomplete =
    sourceMaps.status === "partial" || sourceMaps.status === "unavailable";
  const partial =
    accumulator.parseFailures > 0 ||
    unavailable.length > 0 ||
    sourceMapIncomplete;
  const truncated =
    accumulator.astLimitReached ||
    accumulator.droppedFindings > 0 ||
    sourceMaps.status === "truncated";
  return webBundleAnalysisSchema.parse({
    schema_version: 1,
    capture: buildCaptureObservation(inspection, sourceScripts),
    observations: {
      chunks: {
        nodes: sourceScripts.map(chunkNode),
        edges: accumulator.edges,
      },
      routes: accumulator.routes,
      endpoints: accumulator.endpoints,
      webmcp_declarations: accumulator.webMcp,
      source_maps: sourceMaps,
    },
    inferences: accumulator.inferences,
    unknowns: buildUnknowns({
      sourceScripts,
      unavailable,
      parseFailures: accumulator.parseFailures,
      sourceMaps,
    }),
    completeness: buildCompleteness({
      truncated,
      partial,
      parsedScripts: accumulator.parsedScripts,
      parseFailures: accumulator.parseFailures,
      visitedNodes: accumulator.visitedNodes,
      droppedFindings: accumulator.droppedFindings,
    }),
    limitations: bundleLimitations(),
  });
};

const buildCaptureObservation = (
  inspection: WebPageInspection,
  sourceScripts: IncludedScript[],
) => ({
  target_url: inspection.target.url,
  scripts_observed: inspection.scripts.total,
  scripts_analyzed: sourceScripts.length,
  source_artifacts: sourceScripts.map(sourceArtifact),
});

const sourceArtifact = (script: IncludedScript) => {
  if (!script.source.included)
    throw new TypeError("Filtered source changed");
  const { text: _text, ...artifact } = script.source.artifact;
  return { ...artifact, text_available: true };
};

const chunkNode = (script: IncludedScript) => {
  if (!script.source.included)
    throw new TypeError("Filtered source changed");
  return {
    script_key: script.script_key,
    url: script.url,
    artifact_sha256: script.source.artifact.sha256,
    bytes: script.source.artifact.bytes,
  };
};

interface UnknownsInput {
  readonly sourceScripts: IncludedScript[];
  readonly unavailable: string[];
  readonly parseFailures: number;
  readonly sourceMaps: WebBundleAnalysis["observations"]["source_maps"];
}

const buildUnknowns = (input: UnknownsInput): WebBundleAnalysis["unknowns"] => [
  ...(input.unavailable.length === 0
    ? []
    : [
        {
          dimension: "script_source" as const,
          reason: "Source artifact was not captured within approved limits",
          affected_script_keys: input.unavailable,
        },
      ]),
  ...(input.parseFailures === 0
    ? []
    : [
        {
          dimension: "javascript_ast" as const,
          reason: "One or more source artifacts could not be parsed",
          affected_script_keys: input.sourceScripts.map(
            ({ script_key }) => script_key,
          ),
        },
      ]),
  ...(input.sourceMaps.status === "not_requested" ||
  input.sourceMaps.status === "included"
    ? []
    : [
        {
          dimension: "source_maps" as const,
          reason:
            input.sourceMaps.status === "truncated"
              ? "Source-map evidence was truncated by approved limits"
              : "One or more requested source maps were unavailable or incomplete",
          affected_script_keys: [
            ...new Set([
              ...input.sourceMaps.items
                .filter(({ status }) => status !== "included")
                .map(({ script_key }) => script_key),
              ...input.sourceMaps.dropped_script_keys,
            ]),
          ].sort(),
        },
      ]),
];

interface CompletenessInput {
  readonly truncated: boolean;
  readonly partial: boolean;
  readonly parsedScripts: number;
  readonly parseFailures: number;
  readonly visitedNodes: number;
  readonly droppedFindings: number;
}

const buildCompleteness = (
  input: CompletenessInput,
): WebBundleAnalysis["completeness"] => ({
  status: input.truncated
    ? "truncated"
    : input.partial
      ? "partial"
      : "complete_within_limits",
  parsed_scripts: input.parsedScripts,
  parse_failures: input.parseFailures,
  visited_ast_nodes: input.visitedNodes,
  dropped_findings: input.droppedFindings,
});

const bundleLimitations = (): WebBundleAnalysis["limitations"] => [
  "Static bundle findings are observations or bounded inferences; REA does not execute captured JavaScript.",
  "String-built routes and endpoints, encrypted configuration, and server-side behavior may remain unknown.",
  "Page-declared WebMCP metadata is untrusted and is never registered or invoked as an REA tool.",
];
