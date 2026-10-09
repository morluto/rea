import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import {
  createJavaScriptApplicationGraph,
  createImmutableJavaScriptApplicationGraphSteps,
  type JavaScriptApplicationGraph,
} from "../../domain/javascript/javascriptApplicationGraph.js";
import type { JavaScriptModuleArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFileSet } from "../../domain/javascript/javascriptArtifactFiles.js";
import { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import {
  selfReferenceOmissions,
  type JavaScriptArtifactGraphContext,
} from "./JavaScriptArtifactGraphContext.js";
import {
  addJavaScriptHtmlRoles,
  addJavaScriptSourceMapOriginals,
} from "./JavaScriptArtifactGraphDocuments.js";
import { addJavaScriptStaticFindings } from "./JavaScriptArtifactGraphFindings.js";
import {
  addJavaScriptModuleRelationships,
  type JavaScriptModuleRelationshipOmissions,
  addJavaScriptSourceModules,
} from "./JavaScriptModuleRelationships.js";
import {
  completeApplicationCoverage,
  partialApplicationCoverage,
} from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type { JavaScriptSemanticResourceLimit } from "../../domain/javascript/javascriptSemanticValueTypes.js";
import {
  semanticCoverageResourceLimits,
  semanticResourceLimitCoverage,
} from "../../domain/javascript/javascriptSemanticCoverage.js";
import { semanticResourceLimitReason } from "../../domain/javascript/javascriptSemanticResourceLimits.js";
import {
  addJavaScriptArtifactContainers,
  addJavaScriptArtifactFiles,
  addJavaScriptPackageNodes,
  createJavaScriptArtifactRootNode,
} from "./JavaScriptArtifactGraphStructure.js";
import { addJavaScriptBundlerNodes } from "./JavaScriptArtifactGraphBundlers.js";
import { addElectronBoundaries } from "./ElectronBoundaryGraph.js";
import {
  classifyElectronIpcPairings,
  collectElectronIpcRecords,
} from "./ElectronBoundaryAnalysis.js";

/** Project artifact and AST facts into JavaScript Application Graph. */
export const buildJavaScriptArtifactGraph = (
  snapshot: ArtifactInventorySnapshot,
  fileSet: JavaScriptArtifactFileSet,
  analysis: JavaScriptModuleArtifactAnalysis,
): JavaScriptApplicationGraph =>
  createJavaScriptApplicationGraph(
    buildJavaScriptArtifactGraphInput(snapshot, fileSet, analysis),
  );

/** Build a validated application graph with cooperative immutable ownership. */
export const buildImmutableJavaScriptArtifactGraphSteps = (
  snapshot: ArtifactInventorySnapshot,
  fileSet: JavaScriptArtifactFileSet,
  analysis: JavaScriptModuleArtifactAnalysis,
): Generator<void, JavaScriptApplicationGraph> =>
  createImmutableJavaScriptApplicationGraphSteps(
    buildJavaScriptArtifactGraphInput(snapshot, fileSet, analysis),
  );

const buildJavaScriptArtifactGraphInput = (
  snapshot: ArtifactInventorySnapshot,
  fileSet: JavaScriptArtifactFileSet,
  analysis: JavaScriptModuleArtifactAnalysis,
): unknown => {
  const accumulator = new JavaScriptArtifactGraphAccumulator();
  const root = createJavaScriptArtifactRootNode(accumulator, snapshot);
  const context: JavaScriptArtifactGraphContext = {
    accumulator,
    snapshot,
    fileSet,
    analysis,
    root,
    filesByPath: new Map(fileSet.files.map((file) => [file.path, file])),
    fileNodes: new Map(),
    assetNodes: new Map(),
    sourceModuleNodes: new Map(),
    chunkNodes: new Map(),
    moduleNodes: new Map(),
    containerNodes: new Map([[snapshot.manifest.root_sha256, root]]),
  };
  addJavaScriptArtifactContainers(context);
  addJavaScriptArtifactFiles(context);
  const packageRoots = addJavaScriptPackageNodes(context);
  addJavaScriptSourceModules(context);
  const bundlerLimitations = addJavaScriptBundlerNodes(context);
  const relationshipOmissions = addJavaScriptModuleRelationships(context);
  const findingLimitations = addJavaScriptStaticFindings(context);
  addElectronBoundaries(context);
  addJavaScriptHtmlRoles(context);
  addJavaScriptSourceMapOriginals(context);
  const coverage = graphCoverage(context);
  return {
    schema: "JavaScriptApplicationGraph",
    root_node_ids:
      packageRoots.length === 0
        ? [root.node_id]
        : packageRoots.map(({ node_id: id }) => id),
    nodes: accumulator.nodes(),
    edges: accumulator.edges(),
    coverage,
    limitations: [
      ...bundlerLimitations,
      ...findingLimitations,
      ...graphLimitations(context, coverage.status, relationshipOmissions),
    ],
  };
};

const graphCoverage = (context: JavaScriptArtifactGraphContext) => {
  const resourceLimits = semanticResourceLimits(context);
  const sourceMapPolicyGap = context.analysis.source_maps.some(
    ({ status }) => status === "invalid",
  );
  const malformedStructuredData =
    context.analysis.packages.some(({ status }) => status !== "included") ||
    context.analysis.json_modules.some(({ status }) => status !== "included") ||
    context.analysis.source_maps.some(({ status }) => status === "invalid");
  const partialJavaScript = context.analysis.files.some(
    ({ javascript }) =>
      javascript !== null && javascript.parse_status === "partial",
  );
  const unknownGap =
    context.analysis.parse_failures > 0 ||
    context.fileSet.invalid_utf8_files > 0 ||
    sourceMapPolicyGap ||
    malformedStructuredData ||
    partialJavaScript;
  if (context.analysis.truncated_scopes > 0)
    return partialApplicationCoverage([], null);
  if (resourceLimits.length > 0)
    return partialApplicationCoverage(
      semanticResourceLimitCoverage(resourceLimits),
      null,
    );
  if (unknownGap) return partialApplicationCoverage([], null);
  return completeApplicationCoverage();
};

const semanticResourceLimits = (
  context: JavaScriptArtifactGraphContext,
): JavaScriptSemanticResourceLimit[] =>
  [
    ...new Set(
      context.analysis.files.flatMap(({ semantic }) =>
        semantic === null
          ? []
          : semanticCoverageResourceLimits(semantic.ir.coverage),
      ),
    ),
  ].sort();

const graphLimitations = (
  context: JavaScriptArtifactGraphContext,
  coverage: "complete" | "partial" | "unknown" | "unavailable",
  relationshipOmissions: JavaScriptModuleRelationshipOmissions,
): string[] => {
  const ipc = collectElectronIpcRecords(context.analysis);
  const pairings = classifyElectronIpcPairings(ipc);
  const electronFindings = context.analysis.files.reduce(
    (count, { javascript }) =>
      count +
      (javascript === null
        ? 0
        : javascript.electron.browser_windows.length +
          javascript.electron.context_bridge_apis.length +
          javascript.electron.ipc.length +
          javascript.electron.sender_validations.length +
          javascript.electron.utility_processes.length +
          javascript.electron.native_addon_bindings.length),
    0,
  );
  return [
    ...context.analysis.limitations,
    ...selfReferenceOmissions(
      relationshipOmissions.selfImports,
      ["import specifier", "import specifiers"],
      "the importing module",
    ),
    "CommonJS and ESM binding relationships were recovered from inert syntax and resolved only within the inventoried artifact container.",
    "Webpack/Rspack factories were recovered from AST literals; REA did not invoke push handlers or bundle bootstrap code.",
    "Static imports, entrypoints, workers, endpoints, and storage relationships do not prove runtime execution.",
    ...(electronFindings === 0
      ? []
      : [
          "Electron relationships are derived from inert syntax; runtime registration, reachability, defaults, and enforcement remain unproven.",
        ]),
    ...(ipc.some(({ finding }) => finding.channel === null)
      ? [
          "Dynamic IPC channel expressions remain unresolved and are never paired by textual similarity.",
        ]
      : []),
    ...(pairings.some(({ status }) => status === "ambiguous")
      ? [
          "Some literal IPC channels have multiple compatible main handlers; ambiguous calls are not paired to any handler.",
        ]
      : []),
    ...(context.analysis.files.some(
      ({ javascript }) =>
        (javascript?.electron.sender_validations.length ?? 0) > 0,
    )
      ? [
          "Sender, frame, URL, and origin checks are observations only; REA does not claim that they enforce a complete authorization policy.",
        ]
      : []),
    ...semanticResourceLimits(context).map(semanticResourceLimitReason),
    ...(context.analysis.files.some(
      ({ javascript }) =>
        (javascript?.electron.native_addon_bindings.length ?? 0) > 0,
    )
      ? [
          "Native member names are requested by JavaScript syntax and are not verified binary exports in this workflow.",
        ]
      : []),
    ...(coverage === "complete"
      ? []
      : [
          "Graph coverage is incomplete; unavailable facts remain explicit and must not be read as absence.",
        ]),
  ];
};
