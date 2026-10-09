import { compareCodePoints } from "../../domain/canonicalOrdering.js";

import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";

import {
  ArtifactReaderFailure,
  type ArtifactReader,
} from "../ArtifactReader.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
  type ArtifactNode,
  type ArtifactOccurrence,
  type IntegrityContradiction,
} from "../../domain/artifactGraph.js";
import {
  createArtifactEdges,
  createRootNode,
  indexOccurrencesByPath,
  materializeDirectoryNodes,
  rekeyOccurrences,
  rootOccurrenceFor,
  type MutableOccurrence,
} from "./ArtifactGraphConstruction.js";
import {
  artifactContradictionId,
  artifactGraphDigest,
  artifactManifestId,
} from "../../domain/artifactIdentity.js";
import { classifyRoot } from "./classify.js";
import { hashReadable, type HashResult } from "../ArtifactHash.js";
import { createReader, inventoryLimitations } from "./reader.js";
import {
  scanReader,
  type PendingIntegrityContradiction,
} from "./scanReader.js";
import {
  STRICT_INTEGRITY_POLICY,
  type ArtifactInventoryOptions,
  type ArtifactInventorySnapshot,
} from "./types.js";

export const scanCanonicalArtifactInventory = async (
  path: string,
  options: ArtifactInventoryOptions = {},
  readerFactory: typeof createReader = createReader,
): Promise<ArtifactInventorySnapshot> => {
  const integrity = options.integrity ?? STRICT_INTEGRITY_POLICY;
  const metadata = await lstat(path);
  const rootFormat = await classifyRoot(path, metadata.isDirectory());
  const rootDigest = metadata.isDirectory()
    ? null
    : await hashReadable(createReadStream(path), options.signal);
  const reader = await readerFactory(
    path,
    rootFormat,
    options.environment ?? {},
    options.signal,
  );
  let outcome:
    | {
        readonly kind: "completed";
        readonly snapshot: ArtifactInventorySnapshot;
      }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    const { nodes, occurrences, pendingContradictions } = await scanReader(
      reader,
      options.signal,
      integrity,
    );
    outcome = {
      kind: "completed",
      snapshot: await buildInventorySnapshot({
        path,
        metadata,
        rootFormat,
        rootDigest,
        reader,
        signal: options.signal,
        nodes,
        occurrences,
        pendingContradictions,
      }),
    };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  try {
    await reader?.close();
  } catch (cleanupCause: unknown) {
    const cleanup = ArtifactReaderFailure.cleanupObservation(
      cleanupCause,
      `artifact reader for ${path}`,
    );
    const primary = outcome.kind === "failed" ? outcome.cause : cleanupCause;
    throw ArtifactReaderFailure.withCleanup(
      primary,
      cleanup,
      outcome.kind === "completed"
        ? { kind: "artifact-inventory", inventory: outcome.snapshot }
        : undefined,
    );
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.snapshot;
};

interface SnapshotBuildInput {
  readonly path: string;
  readonly metadata: Stats;
  readonly rootFormat: ArtifactOccurrence["artifact_format"];
  readonly rootDigest: HashResult | null;
  readonly reader: ArtifactReader | undefined;
  readonly signal: AbortSignal | undefined;
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
}

const buildInventorySnapshot = async (
  input: SnapshotBuildInput,
): Promise<ArtifactInventorySnapshot> => {
  const { path, metadata, rootFormat, rootDigest, reader, signal } = input;
  materializeDirectoryNodes(input.occurrences, input.nodes);
  const rootNode = createRootNode({
    digest: rootDigest,
    occurrences: input.occurrences,
  });
  input.nodes.set(rootNode.artifact_id, rootNode);
  rekeyOccurrences(rootNode.artifact_id, input.occurrences);
  const rootOccurrence = rootOccurrenceFor(rootNode, {
    size: metadata.size,
    executable: (metadata.mode & 0o111) !== 0,
    format: rootFormat,
    path,
  });
  for (const occurrence of input.occurrences)
    if (occurrence.parent_occurrence_id === null)
      occurrence.parent_occurrence_id = rootOccurrence.occurrence_id;
  input.occurrences.unshift(rootOccurrence);

  const occurrenceById = new Map(
    input.occurrences.map((occurrence) => [
      occurrence.occurrence_id,
      occurrence,
    ]),
  );
  const occurrenceByPath = indexOccurrencesByPath(input.occurrences);
  const integrityContradictions = buildIntegrityContradictions(
    input.pendingContradictions,
    occurrenceByPath,
    occurrenceById,
    rootNode,
  );
  const edges = createArtifactEdges(
    rootNode.artifact_id,
    input.occurrences,
    reader?.provenance()[0],
  );
  const orderedNodes = sortNodes([...input.nodes.values()]);
  const orderedOccurrences = sortOccurrences(input.occurrences);
  const orderedEdges = sortEdges(edges).map((edge, ordinal) => ({
    ...edge,
    ordinal,
  }));

  await verifyRootDigest(path, rootDigest, signal);

  const graphSha256 = artifactGraphDigest({
    nodes: orderedNodes,
    occurrences: orderedOccurrences,
    edges: orderedEdges,
    contradictions: integrityContradictions,
  });
  const manifest = buildManifest({
    rootNode,
    rootFormat,
    graphSha256,
    orderedNodes,
    orderedOccurrences,
    orderedEdges,
  });
  return {
    manifest,
    nodes: orderedNodes,
    occurrences: orderedOccurrences,
    edges: orderedEdges,
    provenance: reader?.provenance() ?? [],
    integrity_contradictions: integrityContradictions,
    limitations: buildLimitations(rootFormat, reader, integrityContradictions),
  };
};

const buildIntegrityContradictions = (
  pending: readonly PendingIntegrityContradiction[],
  occurrenceByPath: ReadonlyMap<string, MutableOccurrence>,
  occurrenceById: ReadonlyMap<string, MutableOccurrence>,
  rootNode: ArtifactNode,
): IntegrityContradiction[] =>
  pending.map((contradiction): IntegrityContradiction => {
    const occurrence = occurrenceByPath.get(contradiction.logicalPath);
    if (occurrence === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        "Integrity contradiction lost its graph occurrence",
      );
    const parent =
      occurrence.parent_occurrence_id === null
        ? undefined
        : occurrenceById.get(occurrence.parent_occurrence_id);
    const parentArtifactId = parent?.artifact_id ?? rootNode.artifact_id;
    return {
      contradiction_id: artifactContradictionId({
        rootArtifactId: rootNode.artifact_id,
        logicalPath: contradiction.logicalPath,
        declaredSha256: contradiction.declaredSha256,
        observedSha256: contradiction.observedSha256,
      }),
      occurrence_id: occurrence.occurrence_id,
      parent_artifact_id: parentArtifactId,
      logical_path: contradiction.logicalPath,
      declared_sha256: contradiction.declaredSha256,
      observed_sha256: contradiction.observedSha256,
      entry_kind: contradiction.entryKind,
      unpacked: contradiction.unpacked,
      trust: "observed-untrusted",
      provenance: "container-integrity-metadata-versus-observed-bytes",
      limitations: [
        "Observed bytes contradict declared integrity metadata and cannot support equivalence.",
      ],
    };
  });

const verifyRootDigest = async (
  path: string,
  rootDigest: HashResult | null,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (rootDigest === null) return;
  const verified = await hashReadable(createReadStream(path), signal);
  if (
    verified.sha256 !== rootDigest.sha256 ||
    verified.bytes !== rootDigest.bytes
  )
    throw new ArtifactReaderFailure(
      "integrity",
      "Root artifact changed during inventory",
    );
};

const sortNodes = (nodes: ArtifactNode[]): ArtifactNode[] =>
  nodes.sort((left, right) =>
    compareCodePoints(left.artifact_id, right.artifact_id),
  );

const sortOccurrences = (
  occurrences: MutableOccurrence[],
): MutableOccurrence[] =>
  occurrences.sort((left, right) =>
    compareCodePoints(left.logical_path, right.logical_path),
  );

const sortEdges = <T extends { edge_id: string }>(edges: T[]): T[] =>
  edges.sort((left, right) => compareCodePoints(left.edge_id, right.edge_id));

const buildManifest = ({
  rootNode,
  rootFormat,
  graphSha256,
  orderedNodes,
  orderedOccurrences,
  orderedEdges,
}: {
  readonly rootNode: ArtifactNode;
  readonly rootFormat: ArtifactOccurrence["artifact_format"];
  readonly graphSha256: string;
  readonly orderedNodes: readonly ArtifactNode[];
  readonly orderedOccurrences: readonly unknown[];
  readonly orderedEdges: readonly { edge_id: string }[];
}): ArtifactInventoryResult["manifest"] =>
  artifactInventoryResultSchema.shape.manifest.parse({
    manifest_id: artifactManifestId(rootNode.artifact_id, graphSha256),
    root_artifact_id: rootNode.artifact_id,
    root_sha256: rootNode.sha256,
    root_format: rootFormat,
    graph_sha256: graphSha256,
    node_count: orderedNodes.length,
    occurrence_count: orderedOccurrences.length,
    edge_count: orderedEdges.length,
  });

const buildLimitations = (
  rootFormat: ArtifactOccurrence["artifact_format"],
  reader: ArtifactReader | undefined,
  integrityContradictions: readonly IntegrityContradiction[],
): string[] => [
  ...inventoryLimitations(rootFormat, reader),
  ...(integrityContradictions.length === 0
    ? []
    : [
        `${String(integrityContradictions.length)} integrity contradiction(s) were recorded; mismatched content is observed-untrusted.`,
      ]),
];
