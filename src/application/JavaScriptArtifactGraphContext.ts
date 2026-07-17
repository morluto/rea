import type { ArtifactInventorySnapshot } from "./ArtifactInventory.js";
import type { ApplicationGraphEvidence } from "../domain/javascriptApplicationEvidenceSchemas.js";
import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import type { JavaScriptSourceRange } from "../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
  JavaScriptArtifactFileKind,
} from "./JavaScriptArtifactFiles.js";
import { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import {
  artifactObservationEvidence,
  astObservationEvidence,
  completeReconstructionCoverage,
  partialReconstructionCoverage,
  staticInferenceEvidence,
  unavailableAstEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";
import type { JavaScriptArtifactReconstructionInput } from "./JavaScriptArtifactReconstructionInput.js";
import {
  resolveArtifactPathByContext,
  type ArtifactPathResolution,
} from "./JavaScriptArtifactPathResolution.js";

/** Mutable graph-construction state scoped to one reconstruction. */
export interface JavaScriptArtifactGraphContext {
  readonly accumulator: JavaScriptArtifactGraphAccumulator;
  readonly snapshot: ArtifactInventorySnapshot;
  readonly fileSet: JavaScriptArtifactFileSet;
  readonly analysis: JavaScriptArtifactAnalysis;
  readonly input: JavaScriptArtifactReconstructionInput;
  readonly root: ApplicationNode;
  readonly filesByPath: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly fileNodes: Map<string, ApplicationNode>;
  readonly assetNodes: Map<string, ApplicationNode>;
  readonly sourceModuleNodes: Map<string, ApplicationNode>;
  readonly moduleNodes: Map<string, ApplicationNode>;
  readonly containerNodes: Map<string, ApplicationNode>;
}

/** Evidence coverage shape shared by reconstruction graph helpers. */
export type JavaScriptArtifactGraphCoverage =
  ApplicationGraphEvidence["coverage"];

/** Direct artifact-containment edge values. */
export interface ContainsEdgeInput {
  readonly source: ApplicationNode;
  readonly target: ApplicationNode;
  readonly file: JavaScriptArtifactFile;
  readonly operation: string;
}

/** Exact AST containment edge values. */
export interface AstEdgeInput {
  readonly source: ApplicationNode;
  readonly target: ApplicationNode;
  readonly file: JavaScriptArtifactFile;
  readonly range: JavaScriptSourceRange;
  readonly coverage: JavaScriptArtifactGraphCoverage;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Inferred static relationship edge values. */
export interface InferenceEdgeInput extends AstEdgeInput {
  readonly relation:
    | "imports"
    | "loads"
    | "maps_to"
    | "exposes"
    | "calls"
    | "persists_to";
}

/** Electron role identity and static discovery evidence. */
export interface RoleNodeInput {
  readonly kind: "electron-main" | "electron-preload" | "electron-renderer";
  readonly anchor: JavaScriptArtifactFile;
  readonly resolution: ArtifactPathResolution;
  readonly mechanism: string;
  readonly range?: JavaScriptSourceRange;
  readonly coverage?: JavaScriptArtifactGraphCoverage;
}

/** Resolution from an inferred Electron role to an artifact asset. */
export interface RoleAssetLinkInput {
  readonly role: ApplicationNode;
  readonly anchor: JavaScriptArtifactFile;
  readonly resolution: ArtifactPathResolution;
  readonly range?: JavaScriptSourceRange;
  readonly coverage?: JavaScriptArtifactGraphCoverage;
}

/** Explicit package, JavaScript, or source-map parse gap. */
export interface UnavailableParseInput {
  readonly file: JavaScriptArtifactFile;
  readonly asset: ApplicationNode;
  readonly operation: string;
  readonly limitation: string;
}

/** Add a direct artifact-containment edge. */
export const addArtifactContainsEdge = (
  context: JavaScriptArtifactGraphContext,
  input: ContainsEdgeInput,
): void => {
  context.accumulator.addEdge({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: "contains",
    properties: { path: input.file.path },
    evidence: artifactObservationEvidence({
      sha256:
        input.operation === "inventory-entry"
          ? input.file.container_sha256
          : input.file.sha256,
      path: input.file.path,
      operation: input.operation,
      coverage: completeReconstructionCoverage(),
    }),
  });
};

/** Add an exact AST containment edge. */
export const addAstContainsEdge = (
  context: JavaScriptArtifactGraphContext,
  input: AstEdgeInput,
): void => {
  context.accumulator.addEdge({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: "contains",
    properties: input.properties,
    evidence: astObservationEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      range: input.range,
      operation: "map-bundler-structure",
      coverage: input.coverage,
    }),
  });
};

/** Add an explicitly inferred static relationship edge. */
export const addStaticInferenceEdge = (
  context: JavaScriptArtifactGraphContext,
  input: InferenceEdgeInput,
): void => {
  context.accumulator.addEdge({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: input.relation,
    properties: input.properties,
    evidence: staticInferenceEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      range: input.range,
      operation: "map-static-relationship",
      coverage: input.coverage,
    }),
  });
};

/** Preserve a static parse or approval gap as an explicit unknown scope. */
export const addUnavailableStaticParseScope = (
  context: JavaScriptArtifactGraphContext,
  input: UnavailableParseInput,
): void => {
  const node = context.accumulator.addNode({
    kind: "unknown",
    identity: artifactLocalIdentity(
      input.file.sha256,
      "static-parse-scope",
      `${input.operation}:${input.file.path}`,
    ),
    observations: [
      {
        label: `${input.file.path} parse scope`,
        properties: {
          path: input.file.path,
          operation: input.operation,
          limitation: input.limitation,
        },
        evidence: unavailableAstEvidence({
          sha256: input.file.sha256,
          path: input.file.path,
          operation: input.operation,
          coverage: partialReconstructionCoverage([], null, false),
          limitation: input.limitation,
        }),
      },
    ],
  });
  context.accumulator.addEdge({
    source_node_id: input.asset.node_id,
    target_node_id: node.node_id,
    relation: "contains",
    properties: { scope: "unavailable-static-analysis" },
    evidence: artifactObservationEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      operation: "associate-unavailable-parse-scope",
      coverage: completeReconstructionCoverage(),
    }),
  });
};

/** Coverage for one bounded JavaScript AST analysis. */
export const javascriptAnalysisCoverage = (
  analysis: NonNullable<
    JavaScriptArtifactAnalysis["files"][number]["javascript"]
  >,
  input: JavaScriptArtifactReconstructionInput,
): JavaScriptArtifactGraphCoverage =>
  analysis.parse_status === "complete"
    ? completeReconstructionCoverage(javaScriptAnalysisLimits(input))
    : {
        status: "partial",
        truncated: analysis.parse_status === "truncated",
        omitted_count: null,
        limits: javaScriptAnalysisLimits(input),
      };

/** Stable identity for a fact scoped to one exact artifact. */
export const artifactLocalIdentity = (
  sha256: string,
  namespace: string,
  key: string,
) => ({
  strategy: "artifact-local-key" as const,
  stability: "artifact-version" as const,
  artifact_sha256: sha256,
  namespace: namespace.slice(0, 512),
  key: key.slice(0, 4_096),
});

/** Select the graph node kind for one inventoried relevant file. */
export const artifactFileNodeKind = (
  kind: JavaScriptArtifactFileKind,
): ApplicationNode["kind"] =>
  kind === "javascript"
    ? "javascript-asset"
    : kind === "source-map"
      ? "source-map"
      : kind === "native-addon"
        ? "native-addon"
        : "artifact";

/** Create or merge an Electron role inferred from static syntax or metadata. */
export const createElectronRoleNode = (
  context: JavaScriptArtifactGraphContext,
  input: RoleNodeInput,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: input.kind,
    identity: artifactLocalIdentity(
      input.anchor.sha256,
      "electron-role",
      `${input.kind}:${input.resolution.resolution_context}:${input.resolution.resolved_path ?? input.resolution.declared_path}`,
    ),
    observations: [
      {
        label: input.resolution.resolved_path ?? input.resolution.declared_path,
        properties: {
          declared_path: input.resolution.declared_path,
          resolution_context: input.resolution.resolution_context,
          resolved_path: input.resolution.resolved_path,
          resolution_status: input.resolution.resolution_status,
          limitations: input.resolution.limitations,
          mechanism: input.mechanism,
        },
        evidence: staticInferenceEvidence({
          sha256: input.anchor.sha256,
          path: input.anchor.path,
          operation: "discover-electron-entrypoint",
          coverage: input.coverage ?? completeReconstructionCoverage(),
          limitations: input.resolution.limitations,
          ...(input.range === undefined ? {} : { range: input.range }),
        }),
      },
    ],
  });

/** Resolve an Electron role to an inventoried asset when available. */
export const linkElectronRoleToAsset = (
  context: JavaScriptArtifactGraphContext,
  input: RoleAssetLinkInput,
): void => {
  const path = input.resolution.resolved_path;
  if (path === null) return;
  const asset = context.assetNodes.get(path) ?? context.fileNodes.get(path);
  if (asset === undefined) return;
  context.accumulator.addEdge({
    source_node_id: input.role.node_id,
    target_node_id: asset.node_id,
    relation: "maps_to",
    properties: {
      declared_path: input.resolution.declared_path,
      resolution_context: input.resolution.resolution_context,
      resolved_path: path,
      resolution_status: input.resolution.resolution_status,
    },
    evidence: staticInferenceEvidence({
      sha256: input.anchor.sha256,
      path: input.anchor.path,
      operation: "resolve-electron-entrypoint",
      coverage: input.coverage ?? completeReconstructionCoverage(),
      limitations: input.resolution.limitations,
      ...(input.range === undefined ? {} : { range: input.range }),
    }),
  });
};

/** Deterministic key for one recovered module inside a bundle asset. */
export const moduleLookupKey = (path: string, moduleKey: string): string =>
  `${path}\0${moduleKey}`;

/** Resolve a relative static specifier without escaping the artifact root. */
export const resolveArtifactPath = (
  specifier: string,
  sourcePath: string,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  moduleKind?: "import" | "require",
): string | null =>
  resolveArtifactPathByContext({
    declaredPath: specifier,
    sourcePath,
    context: "module-specifier",
    files,
    ...(moduleKind === undefined ? {} : { moduleKind }),
  }).resolved_path;

/** Locate the recovered module that owns a static finding. */
export const sourceNodeFor = (
  context: JavaScriptArtifactGraphContext,
  path: string,
  moduleKey: string | null,
): ApplicationNode | undefined =>
  moduleKey === null
    ? context.sourceModuleNodes.get(path)
    : context.moduleNodes.get(moduleLookupKey(path, moduleKey));

/** Named AST budgets committed to graph evidence coverage. */
export const javaScriptAnalysisLimits = (
  input: JavaScriptArtifactReconstructionInput,
) => [
  {
    name: "max-ast-nodes",
    value: input.limits.max_ast_nodes,
    unit: "items" as const,
  },
  {
    name: "max-findings",
    value: input.limits.max_findings,
    unit: "items" as const,
  },
  {
    name: "max-modules",
    value: input.limits.max_modules,
    unit: "items" as const,
  },
  {
    name: "max-parse-milliseconds",
    value: input.limits.max_parse_milliseconds,
    unit: "milliseconds" as const,
  },
];
