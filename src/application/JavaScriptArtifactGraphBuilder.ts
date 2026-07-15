import type { ArtifactInventorySnapshot } from "./ArtifactInventory.js";
import {
  createJavaScriptApplicationGraph,
  type JavaScriptApplicationGraph,
} from "../domain/javascriptApplicationGraph.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFileSet } from "./JavaScriptArtifactFiles.js";
import { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import {
  javaScriptAnalysisLimits,
  type JavaScriptArtifactGraphContext,
} from "./JavaScriptArtifactGraphContext.js";
import {
  addJavaScriptHtmlRoles,
  addJavaScriptSourceMapOriginals,
} from "./JavaScriptArtifactGraphDocuments.js";
import { addJavaScriptStaticFindings } from "./JavaScriptArtifactGraphFindings.js";
import {
  completeReconstructionCoverage,
  partialReconstructionCoverage,
} from "./JavaScriptArtifactGraphEvidence.js";
import {
  addJavaScriptArtifactContainers,
  addJavaScriptArtifactFiles,
  addJavaScriptBundlerNodes,
  addJavaScriptPackageNodes,
  createJavaScriptArtifactRootNode,
} from "./JavaScriptArtifactGraphStructure.js";
import type { JavaScriptArtifactReconstructionInput } from "./JavaScriptArtifactReconstructionInput.js";

/** Project bounded artifact and AST facts into JavaScript Application Graph v1. */
export const buildJavaScriptArtifactGraph = (
  snapshot: ArtifactInventorySnapshot,
  fileSet: JavaScriptArtifactFileSet,
  analysis: JavaScriptArtifactAnalysis,
  input: JavaScriptArtifactReconstructionInput,
): JavaScriptApplicationGraph => {
  const accumulator = new JavaScriptArtifactGraphAccumulator();
  const root = createJavaScriptArtifactRootNode(accumulator, snapshot);
  const context: JavaScriptArtifactGraphContext = {
    accumulator,
    snapshot,
    fileSet,
    analysis,
    input,
    root,
    filesByPath: new Map(fileSet.files.map((file) => [file.path, file])),
    fileNodes: new Map(),
    assetNodes: new Map(),
    moduleNodes: new Map(),
    containerNodes: new Map([[snapshot.manifest.root_sha256, root]]),
  };
  addJavaScriptArtifactContainers(context);
  addJavaScriptArtifactFiles(context);
  const packageRoots = addJavaScriptPackageNodes(context);
  addJavaScriptBundlerNodes(context);
  addJavaScriptStaticFindings(context);
  addJavaScriptHtmlRoles(context);
  addJavaScriptSourceMapOriginals(context);
  const coverage = graphCoverage(context);
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    schema_version: 1,
    root_node_ids:
      packageRoots.length === 0
        ? [root.node_id]
        : packageRoots.map(({ node_id: id }) => id),
    nodes: accumulator.nodes(),
    edges: accumulator.edges(),
    coverage,
    limitations: graphLimitations(context, coverage.status),
  });
};

const graphCoverage = (context: JavaScriptArtifactGraphContext) => {
  const exactLimitOmissions =
    context.fileSet.limit_omitted_text_files +
    context.accumulator.omittedObservations();
  const sourceMapPolicyGap = context.analysis.source_maps.some(
    ({ status }) => status === "not-approved",
  );
  const malformedStructuredData =
    context.analysis.packages.some(({ status }) => status !== "included") ||
    context.analysis.source_maps.some(({ status }) => status === "invalid");
  const unknownGap =
    context.analysis.parse_failures > 0 ||
    context.fileSet.invalid_utf8_files > 0 ||
    sourceMapPolicyGap ||
    malformedStructuredData;
  if (context.analysis.truncated_scopes > 0)
    return partialReconstructionCoverage(
      reconstructionLimits(context.input),
      null,
      true,
    );
  if (exactLimitOmissions > 0)
    return partialReconstructionCoverage(
      reconstructionLimits(context.input),
      exactLimitOmissions,
      true,
    );
  if (unknownGap)
    return partialReconstructionCoverage(
      reconstructionLimits(context.input),
      null,
      false,
    );
  return completeReconstructionCoverage(reconstructionLimits(context.input));
};

const graphLimitations = (
  context: JavaScriptArtifactGraphContext,
  coverage: "complete" | "partial" | "unknown" | "unavailable",
): string[] => [
  ...context.analysis.limitations,
  "Webpack/Rspack factories were recovered from AST literals; REA did not invoke push handlers or bundle bootstrap code.",
  "Static imports, entrypoints, workers, endpoints, and storage relationships do not prove runtime execution.",
  ...(context.accumulator.omittedObservations() === 0
    ? []
    : [
        "Repeated content identities exceeded the per-node observation bound; containment edges still preserve inventoried paths.",
      ]),
  ...(coverage === "complete"
    ? []
    : [
        "Graph coverage is incomplete; unavailable facts remain explicit and must not be read as absence.",
      ]),
];

const reconstructionLimits = (input: JavaScriptArtifactReconstructionInput) => [
  {
    name: "max-entries",
    value: input.limits.max_entries,
    unit: "items" as const,
  },
  {
    name: "max-total-artifact-bytes",
    value: input.limits.max_total_artifact_bytes,
    unit: "bytes" as const,
  },
  {
    name: "max-text-files",
    value: input.limits.max_text_files,
    unit: "items" as const,
  },
  {
    name: "max-total-text-bytes",
    value: input.limits.max_total_text_bytes,
    unit: "bytes" as const,
  },
  ...javaScriptAnalysisLimits(input),
  { name: "max-observations-per-node", value: 64, unit: "items" as const },
];
