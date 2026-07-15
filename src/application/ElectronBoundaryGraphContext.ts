import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import { sha256Text } from "../domain/javascriptStaticAnalysisHelpers.js";
import type { JavaScriptSourceRange } from "../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import type {
  JavaScriptArtifactGraphContext,
  JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import {
  astObservationEvidence,
  staticInferenceEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";

/** Values for one Electron syntax relationship retained in the graph. */
export interface ElectronGraphEdgeInput {
  readonly source: ApplicationNode;
  readonly target: ApplicationNode;
  readonly file: JavaScriptArtifactFile;
  readonly range: JavaScriptSourceRange;
  readonly coverage: JavaScriptArtifactGraphCoverage;
  readonly relation:
    | "contains"
    | "loads"
    | "imports"
    | "maps_to"
    | "exposes"
    | "sends"
    | "invokes"
    | "handles";
  readonly operation: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly confidence?: "high" | "medium" | "low";
  readonly limitations?: readonly string[];
}

/** Resolve the file or recovered bundle module that owns one finding. */
export const electronFindingSourceNode = (
  context: JavaScriptArtifactGraphContext,
  file: JavaScriptArtifactFile,
  moduleKey: string | null,
): ApplicationNode | undefined =>
  moduleKey === null
    ? (context.assetNodes.get(file.path) ?? context.fileNodes.get(file.path))
    : context.moduleNodes.get(`${file.path}\0${moduleKey}`);

/** Observation-scoped identity shared safely across different artifact files. */
export const electronObservationIdentity = (
  context: JavaScriptArtifactGraphContext,
  scope: string,
  key: string,
) => ({
  strategy: "observation-fingerprint" as const,
  stability: "observation-only" as const,
  observation_sha256: sha256Text(
    `${context.snapshot.manifest.root_sha256}\0${scope}\0${key}`,
  ),
  scope: scope.slice(0, 4_096),
});

/** Add a direct AST syntax relationship. */
export const addElectronAstEdge = (
  context: JavaScriptArtifactGraphContext,
  input: ElectronGraphEdgeInput,
): void => {
  context.accumulator.addEdge({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: input.relation,
    properties: input.properties,
    evidence: astObservationEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      range: input.range,
      operation: input.operation,
      coverage: input.coverage,
      ...(input.limitations === undefined
        ? {}
        : { limitations: input.limitations }),
    }),
  });
};

/** Add an Electron relationship that static syntax suggests but cannot prove. */
export const addElectronInferenceEdge = (
  context: JavaScriptArtifactGraphContext,
  input: ElectronGraphEdgeInput,
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
      operation: input.operation,
      coverage: input.coverage,
      ...(input.confidence === undefined
        ? {}
        : { confidence: input.confidence }),
      ...(input.limitations === undefined
        ? {}
        : { limitations: input.limitations }),
    }),
  });
};

/** Deterministic source-range key for artifact-local graph identities. */
export const electronRangeKey = (range: JavaScriptSourceRange): string =>
  `${String(range.start.line)}:${String(range.start.column)}-${String(range.end.line)}:${String(range.end.column)}`;

/** Test exact source-range containment without assuming runtime reachability. */
export const electronRangeContains = (
  outer: JavaScriptSourceRange,
  inner: JavaScriptSourceRange,
): boolean =>
  comparePoint(outer.start, inner.start) <= 0 &&
  comparePoint(outer.end, inner.end) >= 0;

const comparePoint = (
  left: JavaScriptSourceRange["start"],
  right: JavaScriptSourceRange["start"],
): number =>
  left.line === right.line
    ? left.column - right.column
    : left.line - right.line;
