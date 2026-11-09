import type { ApplicationNode } from "../../domain/javascript/javascriptApplicationGraphSchemas.js";
import { sha256Text } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  sourceNodeFor,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
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
    | "calls"
    | "handles";
  readonly operation: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly confidence?: "high" | "medium" | "low";
  readonly limitations?: readonly string[];
  readonly loaderAuthority?: "candidate" | undefined;
}

/** Candidate syntax does not establish that the receiver is Electron. */
export const ELECTRON_CANDIDATE_LIMITATION =
  "The Electron module loader is unknown, so this relationship is only a candidate.";

/** Preserve syntax with uncertainty when its Electron receiver is unproven. */
export const electronFindingEvidence = (
  input: Parameters<typeof astObservationEvidence>[0],
  loaderAuthority: "candidate" | undefined,
) =>
  loaderAuthority === "candidate"
    ? staticInferenceEvidence({
        ...input,
        confidence: "low",
        limitations: [
          ...(input.limitations ?? []),
          ELECTRON_CANDIDATE_LIMITATION,
        ],
      })
    : astObservationEvidence(input);

/** Resolve the file or recovered bundle module that owns one finding. */
export const electronFindingSourceNode = (
  context: JavaScriptArtifactGraphContext,
  file: JavaScriptArtifactFile,
  moduleKey: string | null,
  runtime?: string,
): ApplicationNode | undefined =>
  moduleKey === null
    ? (context.assetNodes.get(file.path) ?? context.fileNodes.get(file.path))
    : sourceNodeFor(context, file.path, moduleKey, runtime);

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
  scope,
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
    properties: {
      ...input.properties,
      ...(input.loaderAuthority === "candidate"
        ? { loader_authority: "candidate" }
        : {}),
    },
    evidence: electronFindingEvidence(
      {
        sha256: input.file.sha256,
        path: input.file.path,
        range: input.range,
        operation: input.operation,
        coverage: input.coverage,
        ...(input.limitations === undefined
          ? {}
          : { limitations: input.limitations }),
      },
      input.loaderAuthority,
    ),
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
    properties: {
      ...input.properties,
      ...(input.loaderAuthority === "candidate"
        ? { loader_authority: "candidate" }
        : {}),
    },
    evidence: staticInferenceEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      range: input.range,
      operation: input.operation,
      coverage: input.coverage,
      ...(input.loaderAuthority === "candidate"
        ? { confidence: "low" as const }
        : input.confidence === undefined
          ? {}
          : { confidence: input.confidence }),
      ...(input.loaderAuthority === "candidate"
        ? {
            limitations: [
              ...(input.limitations ?? []),
              ELECTRON_CANDIDATE_LIMITATION,
            ],
          }
        : input.limitations === undefined
          ? {}
          : { limitations: input.limitations }),
    }),
  });
};
