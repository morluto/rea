import { ELECTRON_IDENTITY_LIMITATION } from "../../domain/javascript/javascriptElectronMemberWrites.js";
import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import {
  createJavaScriptApplicationGraph,
  sealTransferredJavaScriptApplicationGraphSteps,
  type JavaScriptApplicationGraph,
} from "../../domain/javascript/javascriptApplicationGraph.js";
import type { JavaScriptModuleArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFileSet } from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JavaScriptEvidenceAdmission } from "../../domain/javascript/javascriptSourceAnalysis.js";
import { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import {
  selfReferenceOmissions,
  type JavaScriptArtifactGraphContext,
} from "./JavaScriptArtifactGraphContext.js";
import {
  addJavaScriptHtmlRoles,
  addJavaScriptSourceMapOriginals,
} from "./JavaScriptArtifactGraphDocuments.js";
import { addJavaScriptStaticFindingsSteps } from "./JavaScriptArtifactGraphFindings.js";
import {
  addJavaScriptModuleRelationshipsSteps,
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
    completeSynchronously(
      buildJavaScriptArtifactGraphInputSteps(snapshot, fileSet, analysis),
    ),
  );

/**
 * Build a validated application graph with cooperative immutable ownership.
 * Constructing the graph input also runs in steps: projecting every module
 * relationship and finding at once held the event loop for seconds.
 */
export function* buildImmutableJavaScriptArtifactGraphSteps(
  snapshot: ArtifactInventorySnapshot,
  fileSet: JavaScriptArtifactFileSet,
  analysis: JavaScriptModuleArtifactAnalysis,
  budget?: JavaScriptEvidenceAdmission,
): Generator<void, JavaScriptApplicationGraph> {
  const input = yield* buildJavaScriptArtifactGraphInputSteps(
    snapshot,
    fileSet,
    analysis,
    budget,
  );
  // The input was built here and is not retained, so it can be transferred.
  return yield* sealTransferredJavaScriptApplicationGraphSteps(input);
}

const completeSynchronously = <Value>(steps: Iterator<void, Value>): Value => {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
};

function* buildJavaScriptArtifactGraphInputSteps(
  snapshot: ArtifactInventorySnapshot,
  fileSet: JavaScriptArtifactFileSet,
  analysis: JavaScriptModuleArtifactAnalysis,
  budget?: JavaScriptEvidenceAdmission,
): Generator<void, unknown> {
  const accumulator = new JavaScriptArtifactGraphAccumulator(budget);
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
  yield;
  addJavaScriptArtifactFiles(context);
  yield;
  // Raw observations remain on the file nodes. Only admitted expansions feed
  // the relationship builders, including their Electron and bundler callers.
  const projectionContext = {
    ...context,
    analysis: {
      ...analysis,
      files: analysis.files.map((file) =>
        file.application_projection_failure === undefined
          ? file
          : { ...file, javascript: null, semantic: null },
      ),
    },
  };
  const packageRoots = addJavaScriptPackageNodes(projectionContext);
  yield;
  addJavaScriptSourceModules(projectionContext);
  yield;
  const bundlerLimitations = addJavaScriptBundlerNodes(projectionContext);
  const relationshipOmissions =
    yield* addJavaScriptModuleRelationshipsSteps(projectionContext);
  const findingLimitations =
    yield* addJavaScriptStaticFindingsSteps(projectionContext);
  addElectronBoundaries(projectionContext);
  yield;
  addJavaScriptHtmlRoles(projectionContext);
  yield;
  addJavaScriptSourceMapOriginals(projectionContext);
  yield;
  const coverage = graphCoverage(context);
  const metadata = {
    schema: "JavaScriptApplicationGraph",
    root_node_ids:
      packageRoots.length === 0
        ? [root.node_id]
        : packageRoots.map(({ node_id: id }) => id),
    coverage,
    limitations: [
      ...bundlerLimitations,
      ...findingLimitations,
      ...graphLimitations(context, coverage.status, relationshipOmissions),
    ],
  };
  accumulator.chargeMetadata(metadata);
  return {
    schema: metadata.schema,
    root_node_ids: metadata.root_node_ids,
    nodes: accumulator.nodes(),
    edges: accumulator.edges(),
    coverage: metadata.coverage,
    limitations: metadata.limitations,
  };
}

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
    (context.fileSet.source_selection?.unselected_files ?? 0) > 0 ||
    context.analysis.files.some(
      ({ analysis_failure, application_projection_failure }) =>
        analysis_failure !== undefined ||
        application_projection_failure !== undefined,
    ) ||
    context.analysis.parse_failures > 0 ||
    context.fileSet.invalid_utf8_files > 0 ||
    sourceMapPolicyGap ||
    malformedStructuredData ||
    partialJavaScript;
  const executionLimits = context.analysis.files.flatMap(
    ({ analysis_failure, application_projection_failure }) =>
      [analysis_failure, application_projection_failure].flatMap((failure) =>
        failure === undefined
          ? []
          : javaScriptAnalysisCoverageLimits(failure.limits),
      ),
  );
  if (resourceLimits.length > 0 || executionLimits.length > 0)
    return partialApplicationCoverage(
      [
        ...new Map(
          [
            ...semanticResourceLimitCoverage(resourceLimits),
            ...executionLimits,
          ].map((limit) => [JSON.stringify(limit), limit]),
        ).values(),
      ],
      null,
    );
  if (unknownGap) return partialApplicationCoverage([], null);
  if (context.snapshot.integrity_contradictions.length > 0) {
    const nestedArchiveWasOpaque =
      context.snapshot.integrity_contradictions.some(({ logical_path }) =>
        logical_path.toLowerCase().endsWith(".asar"),
      );
    return partialApplicationCoverage([], nestedArchiveWasOpaque ? null : 0);
  }
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
    ...(context.fileSet.source_selection === undefined
      ? []
      : [
          `Caller-selected source analysis leaves ${String(context.fileSet.source_selection.unselected_files)} inventoried files outside analysis scope. Inventory identity covers the complete artifact; relationships through unselected sources remain unknown.`,
        ]),
    ...context.snapshot.integrity_contradictions.map(
      ({ logical_path: path }) =>
        `Artifact integrity metadata contradicts observed bytes at ${path}; the observed bytes are untrusted.`,
    ),
    ...selfReferenceOmissions(
      relationshipOmissions.selfImports,
      ["import specifier", "import specifiers"],
      "the importing module",
    ),
    "CommonJS and ESM binding relationships were recovered from inert syntax and resolved only within the inventoried artifact container.",
    "Webpack/Rspack factories were recovered from AST literals; REA did not invoke push handlers or bundle bootstrap code.",
    "Static imports, entrypoints, workers, endpoints, and storage relationships do not prove runtime execution.",
    ...(context.analysis.files.some(({ javascript }) =>
      javascript?.limitations.includes(ELECTRON_IDENTITY_LIMITATION),
    )
      ? [ELECTRON_IDENTITY_LIMITATION]
      : []),
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
import { javaScriptAnalysisCoverageLimits } from "../../domain/javascript/javascriptAnalysisResourceControls.js";
