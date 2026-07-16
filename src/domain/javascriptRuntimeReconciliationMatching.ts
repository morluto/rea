import {
  compareCodePoints,
  createJavaScriptApplicationEdge,
  type ApplicationEdge,
  type ApplicationGraphEvidence,
} from "./javascriptApplicationGraph.js";
import {
  digestCanonical,
  type ParsedStaticLayer,
} from "./javascriptRuntimeReconciliationParsing.js";
import type { JavaScriptRuntimeReconciliationItem } from "./javascriptRuntimeReconciliationSchemas.js";
import type { RuntimeReconciliationEntity } from "./javascriptRuntimeReconciliationRuntime.js";
import {
  mappedRuntimePaths,
  type MappedRuntimePath,
  type StaticRuntimeCandidate,
} from "./javascriptRuntimeStaticCandidates.js";

export interface RuntimeMatchingProjection {
  readonly items: readonly JavaScriptRuntimeReconciliationItem[];
  readonly edges: readonly ApplicationEdge[];
  readonly omittedItems: number;
}

/** Match runtime entities conservatively and emit only inferred observed_as edges. */
export const reconcileRuntimeEntities = (input: {
  readonly entities: readonly RuntimeReconciliationEntity[];
  readonly candidates: readonly StaticRuntimeCandidate[];
  readonly layers: readonly ParsedStaticLayer[];
  readonly maximumItems: number;
}): RuntimeMatchingProjection => {
  const index = indexCandidates(input.candidates);
  const evaluated = input.entities.map((entity) =>
    reconcileEntity(entity, index, input.layers),
  );
  const retained = evaluated
    .sort((left, right) =>
      compareCodePoints(
        left.item.reconciliation_id,
        right.item.reconciliation_id,
      ),
    )
    .slice(0, input.maximumItems);
  return {
    items: retained.map(({ item }) => item),
    edges: retained.flatMap(({ edge }) => (edge === null ? [] : [edge])),
    omittedItems: evaluated.length - retained.length,
  };
};

interface EvaluatedMatch {
  readonly item: JavaScriptRuntimeReconciliationItem;
  readonly edge: ApplicationEdge | null;
}

interface CandidateIndex {
  readonly byCategoryDigest: ReadonlyMap<
    string,
    readonly StaticRuntimeCandidate[]
  >;
  readonly byLayerCategoryPath: ReadonlyMap<
    string,
    readonly StaticRuntimeCandidate[]
  >;
}

const reconcileEntity = (
  entity: RuntimeReconciliationEntity,
  index: CandidateIndex,
  layers: readonly ParsedStaticLayer[],
): EvaluatedMatch => {
  const locations = candidatesWithLocation(entity, index, layers);
  if (entity.sourceSha256 !== null) {
    const content =
      index.byCategoryDigest.get(
        categoryDigestKey(entity.staticKind, entity.sourceSha256),
      ) ?? [];
    const locatedKeys = new Set(
      locations.map(({ candidate }) => candidateKey(candidate)),
    );
    const combined = content.filter((candidate) =>
      locatedKeys.has(candidateKey(candidate)),
    );
    if (combined.length === 1)
      return matched(entity, combined[0]!, {
        basis: "content-and-location",
        confidence: "high",
        reason: "content-and-location-match",
      });
    if (content.length === 1) {
      const candidate = content[0]!;
      const digestBasis = candidate.digests.find(
        ({ sha256 }) => sha256 === entity.sourceSha256,
      )?.basis;
      return matched(entity, candidate, {
        basis: digestBasis ?? "content-sha256",
        confidence: "high",
        reason: "unique-content-match",
      });
    }
    if (content.length > 1)
      return unresolved(entity, {
        status: "ambiguous",
        basis: "none",
        confidence: "unknown",
        reason: "ambiguous-static-candidates",
        candidates: content,
      });
    if (locations.length > 0)
      return unresolved(entity, {
        status: "unmatched",
        basis: strongestLocationBasis(locations),
        confidence: "high",
        reason: "captured-content-disagrees-with-static-location",
        candidates: locations.map(({ candidate }) => candidate),
      });
    return unresolved(entity, {
      status: "unmatched",
      basis: "none",
      confidence: "high",
      reason: "no-static-content-match",
      candidates: [],
    });
  }

  if (locations.length === 1) {
    const located = locations[0]!;
    return matched(entity, located.candidate, {
      basis: located.mapping.basis,
      confidence: "medium",
      reason: "unique-location-match",
    });
  }
  if (locations.length > 1)
    return unresolved(entity, {
      status: "ambiguous",
      basis: strongestLocationBasis(locations),
      confidence: "unknown",
      reason: "ambiguous-static-candidates",
      candidates: locations.map(({ candidate }) => candidate),
    });
  const mapped = layers.some(
    (layer) => mappedRuntimePaths(layer, entity).length > 0,
  );
  return unresolved(entity, {
    status: mapped ? "unmatched" : "unknown",
    basis: "none",
    confidence: "unknown",
    reason: mapped
      ? "no-static-content-match"
      : "no-authorized-location-mapping",
    candidates: [],
  });
};

interface LocatedCandidate {
  readonly candidate: StaticRuntimeCandidate;
  readonly mapping: MappedRuntimePath;
}

const candidatesWithLocation = (
  entity: RuntimeReconciliationEntity,
  index: CandidateIndex,
  layers: readonly ParsedStaticLayer[],
): LocatedCandidate[] => {
  const located = new Map<string, LocatedCandidate>();
  for (const layer of layers)
    for (const mapping of mappedRuntimePaths(layer, entity))
      for (const candidate of index.byLayerCategoryPath.get(
        layerCategoryPathKey(layer.layerId, entity.staticKind, mapping.path),
      ) ?? []) {
        const key = candidateKey(candidate);
        if (!located.has(key)) located.set(key, { candidate, mapping });
      }
  return [...located.values()].sort((left, right) =>
    compareCodePoints(
      candidateKey(left.candidate),
      candidateKey(right.candidate),
    ),
  );
};

const indexCandidates = (
  candidates: readonly StaticRuntimeCandidate[],
): CandidateIndex => {
  const byCategoryDigest = new Map<string, StaticRuntimeCandidate[]>();
  const byLayerCategoryPath = new Map<string, StaticRuntimeCandidate[]>();
  for (const candidate of candidates) {
    for (const { sha256 } of candidate.digests)
      appendIndex(
        byCategoryDigest,
        categoryDigestKey(candidate.category, sha256),
        candidate,
      );
    for (const path of candidate.paths)
      appendIndex(
        byLayerCategoryPath,
        layerCategoryPathKey(candidate.layer.layerId, candidate.category, path),
        candidate,
      );
  }
  return { byCategoryDigest, byLayerCategoryPath };
};

const appendIndex = (
  index: Map<string, StaticRuntimeCandidate[]>,
  key: string,
  candidate: StaticRuntimeCandidate,
): void => {
  const values = index.get(key);
  if (values === undefined) index.set(key, [candidate]);
  else values.push(candidate);
};

const categoryDigestKey = (category: string, digest: string): string =>
  `${category}\0${digest}`;

const layerCategoryPathKey = (
  layerId: string,
  category: string,
  path: string,
): string => `${layerId}\0${category}\0${path}`;

const matched = (
  entity: RuntimeReconciliationEntity,
  candidate: StaticRuntimeCandidate,
  input: Pick<ItemInput, "basis" | "confidence" | "reason">,
): EvaluatedMatch => {
  const item = createItem(entity, {
    layer: candidate.layer,
    staticNodeId: candidate.node.node_id,
    status: "matched",
    basis: input.basis,
    confidence: input.confidence,
    reason: input.reason,
    candidates: [candidate],
  });
  return {
    item,
    edge: createJavaScriptApplicationEdge({
      source_node_id: candidate.node.node_id,
      target_node_id: entity.node.node_id,
      relation: "observed_as",
      properties: {
        reconciliation_id: item.reconciliation_id,
        basis: input.basis,
        static_layer_id: candidate.layer.layerId,
      },
      evidence: reconciliationEvidence(
        entity,
        candidate.layer,
        input.basis,
        input.confidence,
      ),
    }),
  };
};

const unresolved = (
  entity: RuntimeReconciliationEntity,
  input: Pick<
    ItemInput,
    "status" | "basis" | "confidence" | "reason" | "candidates"
  >,
): EvaluatedMatch => ({
  item: createItem(entity, {
    layer: null,
    staticNodeId: null,
    status: input.status,
    basis: input.basis,
    confidence: input.confidence,
    reason: input.reason,
    candidates: input.candidates,
  }),
  edge: null,
});

interface ItemInput {
  readonly layer: ParsedStaticLayer | null;
  readonly staticNodeId: string | null;
  readonly status: JavaScriptRuntimeReconciliationItem["status"];
  readonly basis: JavaScriptRuntimeReconciliationItem["basis"];
  readonly confidence: JavaScriptRuntimeReconciliationItem["confidence"];
  readonly reason: JavaScriptRuntimeReconciliationItem["reason"];
  readonly candidates: readonly StaticRuntimeCandidate[];
}

const createItem = (
  entity: RuntimeReconciliationEntity,
  input: ItemInput,
): JavaScriptRuntimeReconciliationItem => {
  const candidateReferences = uniqueCandidateReferences(input.candidates);
  const semantic = {
    entity_kind: entity.kind,
    runtime_evidence_id: entity.capture.evidence.evidence_id,
    runtime_node_id: entity.node.node_id,
    static_layer_id: input.layer?.layerId ?? null,
    static_node_id: input.staticNodeId,
    status: input.status,
    basis: input.basis,
    confidence: input.confidence,
    reason: input.reason,
    candidate_static_count: candidateReferences.count,
    candidate_static_nodes: candidateReferences.items,
  } satisfies Omit<JavaScriptRuntimeReconciliationItem, "reconciliation_id">;
  return {
    reconciliation_id: `jrr_item_${digestCanonical(semantic)}`,
    ...semantic,
  };
};

const reconciliationEvidence = (
  entity: RuntimeReconciliationEntity,
  layer: ParsedStaticLayer,
  basis: JavaScriptRuntimeReconciliationItem["basis"],
  confidence: JavaScriptRuntimeReconciliationItem["confidence"],
): ApplicationGraphEvidence => ({
  authority: "cross-layer-reconciliation",
  state: "inferred",
  confidence: confidence === "medium" ? "medium" : "high",
  artifact:
    entity.sourceSha256 === null
      ? {
          available: false,
          reason: "not-observed",
          detail: "Runtime source bytes were not captured for this mapping.",
        }
      : {
          available: true,
          artifact_id: `art_${entity.sourceSha256}`,
          sha256: entity.sourceSha256,
        },
  location: entity.node.observations[0]!.evidence.location,
  extractor: {
    name: "rea-javascript-runtime-reconciliation",
    version: "1",
    operation: "reconcile_javascript_runtime",
    executable_sha256: null,
  },
  coverage:
    layer.graph.coverage.status === "complete" &&
    entity.capture.scriptsCompleteWithinScope
      ? { status: "complete", truncated: false, omitted_count: 0, limits: [] }
      : {
          status: "partial",
          truncated: false,
          omitted_count: null,
          limits: [],
        },
  limitations: [
    basis === "content-sha256" ||
    basis === "module-source-sha256" ||
    basis === "content-and-location"
      ? "Equal content digests establish byte identity, not execution causality."
      : "Location correspondence is inferred from an artifact root or caller-declared mapping.",
    "Passive script parsing or target presence does not prove feature execution.",
  ],
  evidence_ids: [
    layer.evidence.evidence_id,
    entity.capture.evidence.evidence_id,
  ].sort(),
});

const strongestLocationBasis = (
  values: readonly LocatedCandidate[],
): JavaScriptRuntimeReconciliationItem["basis"] => {
  const bases = new Set(values.map(({ mapping }) => mapping.basis));
  if (bases.has("artifact-path")) return "artifact-path";
  if (bases.has("operator-file-mapping")) return "operator-file-mapping";
  return "operator-url-mapping";
};

const candidateKey = (candidate: StaticRuntimeCandidate): string =>
  `${candidate.layer.layerId}:${candidate.node.node_id}`;

const uniqueCandidateReferences = (
  candidates: readonly StaticRuntimeCandidate[],
): {
  readonly count: number;
  readonly items: JavaScriptRuntimeReconciliationItem["candidate_static_nodes"];
} => {
  const seen = new Set<string>();
  let count = 0;
  const items: JavaScriptRuntimeReconciliationItem["candidate_static_nodes"] =
    [];
  for (const { layer, node } of candidates) {
    const key = `${layer.layerId}:${node.node_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
    if (items.length < 1_000)
      items.push({
        static_layer_id: layer.layerId,
        static_node_id: node.node_id,
      });
  }
  return { count, items };
};
