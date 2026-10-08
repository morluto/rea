import type { WebPageInspection } from "./browserObservation.js";
import {
  webBundleAnalysisSchema,
  type WebBundleAnalysis,
} from "./webBundleAnalysis.js";
import type {
  AnalysisAccumulator,
  IncludedScript,
} from "./webBundleAnalyzerInspection.js";

export const buildWebBundleAnalysis = (
  inspection: WebPageInspection,
  sourceScripts: IncludedScript[],
  sourceMaps: WebBundleAnalysis["observations"]["source_maps"],
  accumulator: AnalysisAccumulator,
): WebBundleAnalysis => {
  const unavailable = inspection.scripts.items
    .filter((script) => !script.source.included)
    .map(({ script_key }) => script_key);
  const omittedScripts = captureBudgetOmission(inspection, "scripts");
  const omittedSourceMaps =
    sourceMaps.status === "not_requested"
      ? undefined
      : captureBudgetOmission(inspection, "source_maps");
  const sourceMapIncomplete =
    sourceMaps.status === "partial" || sourceMaps.status === "unavailable";
  const partial =
    accumulator.parseFailures > 0 ||
    unavailable.length > 0 ||
    sourceMapIncomplete ||
    omittedScripts !== undefined ||
    omittedSourceMaps !== undefined;
  return webBundleAnalysisSchema.parse({
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
      omittedScripts,
      omittedSourceMaps,
    }),
    completeness: buildCompleteness({
      partial,
      parsedScripts: accumulator.parsedScripts,
      parseFailures: accumulator.parseFailures,
      visitedNodes: accumulator.visitedNodes,
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
  if (!script.source.included) throw new TypeError("Filtered source changed");
  const { text: _text, ...artifact } = script.source.artifact;
  return { ...artifact, text_available: true };
};

const chunkNode = (script: IncludedScript) => {
  if (!script.source.included) throw new TypeError("Filtered source changed");
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
  readonly omittedScripts: number | null | undefined;
  readonly omittedSourceMaps: number | null | undefined;
}

const buildUnknowns = (input: UnknownsInput): WebBundleAnalysis["unknowns"] => [
  ...(input.omittedScripts === undefined
    ? []
    : [
        {
          dimension: "script_inventory",
          reason: captureBudgetReason("script records", input.omittedScripts),
          affected_script_keys: [],
        },
      ]),
  ...(input.unavailable.length === 0
    ? []
    : [
        {
          dimension: "script_source" as const,
          reason: "Source artifact was not captured",
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
  ...(input.omittedSourceMaps === undefined
    ? []
    : [
        {
          dimension: "source_maps" as const,
          reason: captureBudgetReason(
            "source-map declarations",
            input.omittedSourceMaps,
          ),
          affected_script_keys: [],
        },
      ]),
  ...(input.sourceMaps.status === "not_requested" ||
  input.sourceMaps.status === "included"
    ? []
    : [
        {
          dimension: "source_maps" as const,
          reason:
            input.sourceMaps.limitation ??
            "One or more requested source maps were unavailable or incomplete",
          affected_script_keys: input.sourceMaps.items
            .filter(({ status }) => status !== "included")
            .map(({ script_key }) => script_key)
            .sort(),
        },
      ]),
];

const captureBudgetOmission = (
  inspection: WebPageInspection,
  section: "scripts" | "source_maps",
): number | null | undefined => {
  const exclusions = inspection.completeness.excluded.filter(
    (exclusion) =>
      exclusion.section === section &&
      exclusion.reason === "resource_budget_exhausted",
  );
  if (exclusions.length === 0) return undefined;
  if (exclusions.some(({ count }) => count === null)) return null;
  return exclusions.reduce((sum, { count }) => sum + (count ?? 0), 0);
};

const captureBudgetReason = (label: string, count: number | null): string =>
  count === null
    ? `Capture omitted an unknown number of ${label} because its resource budget was exhausted.`
    : `Capture omitted ${String(count)} ${label} because its resource budget was exhausted.`;

interface CompletenessInput {
  readonly partial: boolean;
  readonly parsedScripts: number;
  readonly parseFailures: number;
  readonly visitedNodes: number;
}

const buildCompleteness = (
  input: CompletenessInput,
): WebBundleAnalysis["completeness"] => ({
  status: input.partial ? "partial" : "complete",
  parsed_scripts: input.parsedScripts,
  parse_failures: input.parseFailures,
  visited_ast_nodes: input.visitedNodes,
});

const bundleLimitations = (): WebBundleAnalysis["limitations"] => [
  "Static bundle findings are observations or bounded inferences; REA does not execute captured JavaScript.",
  "String-built routes and endpoints, encrypted configuration, and server-side behavior may remain unknown.",
  "Page-declared WebMCP metadata is untrusted and is never registered or invoked as an REA tool.",
];
