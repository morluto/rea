import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";

import {
  ArtifactReaderFailure,
  type ArtifactLimits,
  type ArtifactReader,
} from "../../artifacts/ArtifactReader.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
  type ArtifactNode,
  type IntegrityContradiction,
} from "../../domain/artifactGraph.js";
import {
  createArtifactEdges,
  createRootNode,
  digestCanonical,
  indexOccurrencesByPath,
  materializeDirectoryNodes,
  rekeyOccurrences,
  rootOccurrenceFor,
  toOutputLimits,
  type MutableOccurrence,
} from "../ArtifactGraphConstruction.js";
import { classifyRoot } from "./classify.js";
import { hashReadable, type HashResult } from "./hash.js";
import { createReader, inventoryLimitations } from "./reader.js";
import {
  scanReader,
  type PendingIntegrityContradiction,
} from "./scanReader.js";
import {
  NATIVE_MOUNT_DISABLED,
  STRICT_INTEGRITY_POLICY,
  type ArtifactInventoryOptions,
  type ArtifactInventorySnapshot,
} from "./types.js";

export const scanCanonicalArtifactInventory = async (
  path: string,
  limits: ArtifactLimits,
  options: ArtifactInventoryOptions = {},
): Promise<ArtifactInventorySnapshot> => {
  const integrity = options.integrity ?? STRICT_INTEGRITY_POLICY;
  if (
    integrity.mode === "record-and-continue" &&
    (!integrity.approved || !integrity.enabled)
  )
    throw new ArtifactReaderFailure(
      "unavailable",
      "Integrity continuation requires explicit approval and operator policy",
    );
  const metadata = await lstat(path);
  const rootFormat = await classifyRoot(path, metadata.isDirectory());
  const rootDigest = metadata.isDirectory()
    ? null
    : await hashReadable(
        createReadStream(path),
        limits.maxTotalBytes,
        options.signal,
      );
  const reader = await createReader(
    path,
    rootFormat,
    options.nativeMount ?? NATIVE_MOUNT_DISABLED,
    options.signal,
  );

  try {
    const { nodes, occurrences, pendingContradictions } = await scanReader(
      reader,
      limits,
      options.signal,
      integrity,
    );
    return await buildInventorySnapshot({
      path,
      metadata,
      rootFormat,
      rootDigest,
      reader,
      limits,
      signal: options.signal,
      nodes,
      occurrences,
      pendingContradictions,
    });
  } finally {
    await reader?.close();
  }
};

interface SnapshotBuildInput {
  readonly path: string;
  readonly metadata: Stats;
  readonly rootFormat: ArtifactNode["format"];
  readonly rootDigest: HashResult | null;
  readonly reader: ArtifactReader | undefined;
  readonly limits: ArtifactLimits;
  readonly signal: AbortSignal | undefined;
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
}

const buildInventorySnapshot = async (
  input: SnapshotBuildInput,
): Promise<ArtifactInventorySnapshot> => {
  const { path, metadata, rootFormat, rootDigest, reader, limits, signal } =
    input;
  materializeDirectoryNodes(input.occurrences, input.nodes);
  const rootNode = createRootNode({
    path,
    format: rootFormat,
    directory: metadata.isDirectory(),
    digest: rootDigest,
    occurrences: input.occurrences,
  });
  input.nodes.set(rootNode.artifact_id, rootNode);
  rekeyOccurrences(rootNode.artifact_id, input.occurrences);
  const rootOccurrence = rootOccurrenceFor(rootNode, metadata.size);
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
  const orderedEdges = sortEdges(edges);

  await verifyRootDigest(path, rootDigest, limits.maxTotalBytes, signal);

  const graphSha256 = digestCanonical({
    nodes: orderedNodes,
    occurrences: orderedOccurrences,
    edges: orderedEdges,
    integrity_contradictions: integrityContradictions,
  });
  const manifest = buildManifest({
    rootNode,
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
    limits: toOutputLimits(limits),
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
      contradiction_id: `ic_${digestCanonical({
        root_artifact_id: rootNode.artifact_id,
        logical_path: contradiction.logicalPath,
        declared_sha256: contradiction.declaredSha256,
        observed_sha256: contradiction.observedSha256,
      })}`,
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
  maxTotalBytes: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (rootDigest === null) return;
  const verified = await hashReadable(
    createReadStream(path),
    maxTotalBytes,
    signal,
  );
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
    left.artifact_id.localeCompare(right.artifact_id),
  );

const sortOccurrences = (
  occurrences: MutableOccurrence[],
): MutableOccurrence[] =>
  occurrences.sort((left, right) =>
    left.logical_path.localeCompare(right.logical_path, "en"),
  );

const sortEdges = <T extends { edge_id: string }>(edges: T[]): T[] =>
  edges.sort((left, right) => left.edge_id.localeCompare(right.edge_id));

const buildManifest = ({
  rootNode,
  graphSha256,
  orderedNodes,
  orderedOccurrences,
  orderedEdges,
}: {
  readonly rootNode: ArtifactNode;
  readonly graphSha256: string;
  readonly orderedNodes: readonly ArtifactNode[];
  readonly orderedOccurrences: readonly unknown[];
  readonly orderedEdges: readonly { edge_id: string }[];
}): ArtifactInventoryResult["manifest"] =>
  artifactInventoryResultSchema.shape.manifest.parse({
    schema_version: 1,
    manifest_id: `agm_${digestCanonical({
      schema_version: 1,
      root_artifact_id: rootNode.artifact_id,
      graph_sha256: graphSha256,
    })}`,
    root_artifact_id: rootNode.artifact_id,
    root_sha256: rootNode.sha256,
    root_format: rootNode.format,
    graph_sha256: graphSha256,
    node_count: orderedNodes.length,
    occurrence_count: orderedOccurrences.length,
    edge_count: orderedEdges.length,
  });

const buildLimitations = (
  rootFormat: ArtifactNode["format"],
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
