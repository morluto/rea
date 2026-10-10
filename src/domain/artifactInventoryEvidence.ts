import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
  type ArtifactNode,
  type ArtifactOccurrence,
  type IntegrityContradiction,
} from "./artifactGraph.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { canonicalJson } from "./comparisonSemantics.js";
import {
  artifactContradictionId,
  artifactEdgeId,
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "./artifactIdentity.js";
import { parseEvidence, type Evidence } from "./evidence.js";
import { artifactInspectionResultSchema } from "./artifactInspection.js";

/** Complete or partially assembled inventory used by comparison workflows. */
export interface InventorySet {
  readonly manifest: ArtifactInventoryResult["manifest"];
  readonly nodes: readonly ArtifactNode[];
  readonly occurrences: readonly ArtifactOccurrence[];
  readonly edges: readonly ArtifactInventoryResult["edges"][number][];
  readonly integrityContradictions: readonly IntegrityContradiction[];
  readonly limitations: readonly string[];
  readonly complete: boolean;
}

export interface ParsedInventorySet {
  readonly evidence: readonly Evidence[];
  readonly inventory: InventorySet;
}

/** Parse, merge, and verify inventory Evidence pages. */
export const parseArtifactInventoryEvidence = (
  input: unknown,
): ParsedInventorySet =>
  assembleInventorySet(
    (Array.isArray(input) ? input : [input]).map((value) => {
      const evidence = parseEvidence(value);
      const inventoryEvidence =
        evidence.operation === "inventory_artifact"
          ? evidence
          : evidence.operation === "inspect_artifact"
            ? artifactInspectionResultSchema.parse(evidence.normalized_result)
                .substeps[0]?.evidence
            : undefined;
      if (inventoryEvidence === undefined)
        throw new TypeError(
          "Artifact comparison requires inspect_artifact Evidence",
        );
      const inventory = artifactInventoryResultSchema.parse(
        inventoryEvidence.normalized_result,
      );
      if (
        inventoryEvidence.subject === null ||
        inventoryEvidence.subject.digest.sha256 !==
          inventory.manifest.root_sha256 ||
        inventoryEvidence.subject.format !== inventory.manifest.root_format
      )
        throw new TypeError(
          "Artifact inventory Evidence subject does not match its root digest",
        );
      validateInventoryPage(inventory);
      return { evidence, inventory };
    }),
  );

const validateInventoryPage = (inventory: ArtifactInventoryResult): void => {
  assertUnique(
    inventory.nodes.map(({ artifact_id: id }) => id),
    "node ID",
  );
  assertUnique(
    inventory.occurrences.map(({ occurrence_id: id }) => id),
    "occurrence ID",
  );
  assertUnique(
    inventory.occurrences.map(({ logical_path: path }) => path),
    "logical path",
  );
  assertUnique(
    inventory.edges.map(({ edge_id: id }) => id),
    "edge ID",
  );
  for (const node of inventory.nodes)
    if (node.artifact_id !== artifactIdForContent(node.sha256))
      throw new TypeError("Artifact node ID is not content-addressed");
};

const assembleInventorySet = (
  pages: readonly {
    readonly evidence: Evidence;
    readonly inventory: ArtifactInventoryResult;
  }[],
): ParsedInventorySet => {
  const first = pages[0];
  if (first === undefined)
    throw new TypeError("Artifact inventory requires Evidence pages");
  const manifestJson = canonicalJson(
    first.inventory.manifest,
    "Artifact inventory",
  );
  const nodes = new Map<string, ArtifactNode>();
  const occurrences = new Map<string, ArtifactOccurrence>();
  const paths = new Map<string, ArtifactOccurrence>();
  const edges = new Map<string, ArtifactInventoryResult["edges"][number]>();
  for (const page of pages) {
    if (
      canonicalJson(page.inventory.manifest, "Artifact inventory") !==
      manifestJson
    )
      throw new TypeError("Artifact inventory pages do not share one manifest");
    if (
      canonicalJson(
        page.inventory.integrity_contradictions,
        "Artifact inventory",
      ) !==
      canonicalJson(
        first.inventory.integrity_contradictions,
        "Artifact inventory",
      )
    )
      throw new TypeError(
        "Artifact inventory pages do not share integrity contradictions",
      );
    for (const node of page.inventory.nodes)
      mergeExact(nodes, node.artifact_id, node, "node");
    for (const occurrence of page.inventory.occurrences) {
      mergeExact(
        occurrences,
        occurrence.occurrence_id,
        occurrence,
        "occurrence",
      );
      mergeExact(paths, occurrence.logical_path, occurrence, "logical path");
    }
    for (const edge of page.inventory.edges)
      mergeExact(edges, edge.edge_id, edge, "edge");
  }
  const inventory = orderedInventory(first.inventory, pages, {
    nodes,
    occurrences,
    edges,
  });
  if (inventory.complete) validateCompleteInventory(inventory);
  return { evidence: pages.map(({ evidence }) => evidence), inventory };
};

const orderedInventory = (
  first: ArtifactInventoryResult,
  pages: readonly { readonly inventory: ArtifactInventoryResult }[],
  values: {
    readonly nodes: ReadonlyMap<string, ArtifactNode>;
    readonly occurrences: ReadonlyMap<string, ArtifactOccurrence>;
    readonly edges: ReadonlyMap<
      string,
      ArtifactInventoryResult["edges"][number]
    >;
  },
): InventorySet => {
  const nodes = [...values.nodes.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.artifact_id, right.artifact_id),
  );
  const occurrences = [...values.occurrences.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.logical_path, right.logical_path),
  );
  const edges = [...values.edges.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.edge_id, right.edge_id),
  );
  return {
    manifest: first.manifest,
    nodes,
    occurrences,
    edges,
    integrityContradictions: first.integrity_contradictions,
    limitations: [
      ...new Set(pages.flatMap(({ inventory }) => inventory.limitations)),
    ].sort(compareUnicodeCodePoints),
    complete:
      nodes.length === first.manifest.node_count &&
      occurrences.length === first.manifest.occurrence_count &&
      edges.length === first.manifest.edge_count,
  };
};

const validateCompleteInventory = (inventory: InventorySet): void => {
  const nodeIds = new Set(inventory.nodes.map(({ artifact_id: id }) => id));
  const occurrenceIds = new Set(
    inventory.occurrences.map(({ occurrence_id: id }) => id),
  );
  const rootNode = inventory.nodes.find(
    ({ artifact_id: id }) => id === inventory.manifest.root_artifact_id,
  );
  if (rootNode?.sha256 !== inventory.manifest.root_sha256)
    throw new TypeError(
      "Artifact root node does not match its manifest digest",
    );
  const rootOccurrence = inventory.occurrences.find(
    ({ logical_path }) => logical_path === ".",
  );
  if (
    rootOccurrence?.artifact_id !== inventory.manifest.root_artifact_id ||
    rootOccurrence.artifact_format !== inventory.manifest.root_format
  )
    throw new TypeError(
      "Artifact root occurrence does not match its manifest representation",
    );
  for (const occurrence of inventory.occurrences)
    validateOccurrence(occurrence, inventory, nodeIds, occurrenceIds);
  const occurrencesById = new Map(
    inventory.occurrences.map((occurrence) => [
      occurrence.occurrence_id,
      occurrence,
    ]),
  );
  for (const edge of inventory.edges)
    validateEdge(edge, nodeIds, occurrencesById);
  for (const contradiction of inventory.integrityContradictions) {
    if (
      !nodeIds.has(contradiction.parent_artifact_id) ||
      !occurrenceIds.has(contradiction.occurrence_id)
    )
      throw new TypeError(
        "Integrity contradiction references a missing graph member",
      );
    const expectedId = artifactContradictionId({
      rootArtifactId: inventory.manifest.root_artifact_id,
      logicalPath: contradiction.logical_path,
      declaredSha256: contradiction.declared_sha256,
      observedSha256: contradiction.observed_sha256,
    });
    if (contradiction.contradiction_id !== expectedId)
      throw new TypeError(
        "Integrity contradiction ID does not match its identity",
      );
  }
  const graphSha256 = artifactGraphDigest({
    nodes: inventory.nodes,
    occurrences: inventory.occurrences,
    edges: inventory.edges,
    contradictions: inventory.integrityContradictions,
  });
  if (graphSha256 !== inventory.manifest.graph_sha256)
    throw new TypeError("Artifact graph commitment does not match its members");
  const manifestId = artifactManifestId(
    inventory.manifest.root_artifact_id,
    graphSha256,
  );
  if (manifestId !== inventory.manifest.manifest_id)
    throw new TypeError("Artifact manifest ID does not match its commitment");
};

const validateOccurrence = (
  occurrence: ArtifactOccurrence,
  inventory: InventorySet,
  nodeIds: ReadonlySet<string>,
  occurrenceIds: ReadonlySet<string>,
): void => {
  if (occurrence.artifact_id !== null && !nodeIds.has(occurrence.artifact_id))
    throw new TypeError("Artifact occurrence references a missing node");
  if (
    occurrence.parent_occurrence_id !== null &&
    !occurrenceIds.has(occurrence.parent_occurrence_id)
  )
    throw new TypeError("Artifact occurrence references a missing parent");
  const expectedId = occurrenceIdForLocation({
    rootArtifactId: inventory.manifest.root_artifact_id,
    logicalPath: occurrence.logical_path,
    entryKind: occurrence.entry_kind,
  });
  if (occurrence.occurrence_id !== expectedId)
    throw new TypeError("Artifact occurrence ID does not match its identity");
};

const validateEdge = (
  edge: ArtifactInventoryResult["edges"][number],
  nodeIds: ReadonlySet<string>,
  occurrences: ReadonlyMap<string, ArtifactOccurrence>,
): void => {
  const occurrence = occurrences.get(edge.occurrence_id);
  if (
    !nodeIds.has(edge.parent_artifact_id) ||
    occurrence?.artifact_id === null ||
    occurrence === undefined ||
    !nodeIds.has(occurrence.artifact_id)
  )
    throw new TypeError("Artifact edge references a missing graph member");
  if (edge.edge_id !== artifactEdgeId(edge, occurrence))
    throw new TypeError("Artifact edge ID does not match its identity");
};

const mergeExact = <Value>(
  output: Map<string, Value>,
  key: string,
  value: Value,
  label: string,
): void => {
  const previous = output.get(key);
  if (
    previous !== undefined &&
    canonicalJson(previous, "Artifact inventory") !==
      canonicalJson(value, "Artifact inventory")
  )
    throw new TypeError(`Artifact inventory has conflicting ${label} pages`);
  output.set(key, value);
};

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length)
    throw new TypeError(`Artifact inventory contains a duplicate ${label}`);
};
