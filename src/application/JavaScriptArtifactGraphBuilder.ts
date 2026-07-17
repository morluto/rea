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
  addJavaScriptModuleRelationships,
  addJavaScriptSourceModules,
} from "./JavaScriptModuleRelationships.js";
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
import { addElectronBoundaries } from "./ElectronBoundaryGraph.js";
import {
  classifyElectronIpcPairings,
  collectElectronIpcRecords,
} from "./ElectronBoundaryAnalysis.js";

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
    sourceModuleNodes: new Map(),
    moduleNodes: new Map(),
    containerNodes: new Map([[snapshot.manifest.root_sha256, root]]),
  };
  addJavaScriptArtifactContainers(context);
  addJavaScriptArtifactFiles(context);
  const packageRoots = addJavaScriptPackageNodes(context);
  addJavaScriptSourceModules(context);
  addJavaScriptBundlerNodes(context);
  addJavaScriptModuleRelationships(context);
  addJavaScriptStaticFindings(context);
  addElectronBoundaries(context);
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
    return partialReconstructionCoverage(
      reconstructionLimits(context.input),
      truncationOmittedCount(context),
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

const truncationOmittedCount = (
  context: JavaScriptArtifactGraphContext,
): number | null => {
  const staticTruncations = context.analysis.files.filter(
    ({ javascript }) => javascript?.parse_status === "truncated",
  );
  if (staticTruncations.length > 0) return null;
  const semanticTruncations = context.analysis.files.flatMap(({ semantic }) =>
    semantic?.ir.coverage.status === "truncated" ? [semantic.ir.coverage] : [],
  );
  const sourceMapTruncations = context.analysis.source_maps.filter(
    ({ status }) => status === "truncated",
  );
  if (sourceMapTruncations.length > 0) return null;
  if (semanticTruncations.length !== context.analysis.truncated_scopes)
    return null;
  const omissions = semanticTruncations.map(({ omittedCount }) => omittedCount);
  return omissions.some((omitted) => omitted === null)
    ? null
    : omissions.reduce<number>((total, omitted) => total + (omitted ?? 0), 0);
};

const graphLimitations = (
  context: JavaScriptArtifactGraphContext,
  coverage: "complete" | "partial" | "unknown" | "unavailable",
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
    ...(context.analysis.files.some(
      ({ javascript }) =>
        (javascript?.electron.native_addon_bindings.length ?? 0) > 0,
    )
      ? [
          "Native member names are requested by JavaScript syntax and are not verified binary exports in this workflow.",
        ]
      : []),
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
};

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
