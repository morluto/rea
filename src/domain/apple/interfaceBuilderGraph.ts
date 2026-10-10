import { z } from "zod";

import {
  firstString,
  parseInterfaceBuilderRecords,
  record,
} from "./interfaceBuilderKeyedArchive.js";
import {
  nativeInvestigationEdgeSchema,
  nativeInvestigationGraphSchema,
  nativeInvestigationNodeSchema,
  nativeInvestigationTraceLimitsSchema,
} from "../native/nativeInvestigationGraph.js";

/** One compiled Interface Builder document projected from ibtool output. */
export const interfaceBuilderDocumentSchema = z.strictObject({
  relative_path: z.string().min(1),
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  document_kind: z.enum(["nib", "storyboard_scene"]),
  object_count: z.number().int().nonnegative(),
  connection_count: z.number().int().nonnegative(),
  hierarchy_complete: z.boolean(),
});

/** Normalized read-only Interface Builder graph with archive provenance. */
export const interfaceBuilderAnalysisSchema = z.strictObject({
  target_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  documents: z.array(interfaceBuilderDocumentSchema).max(64),
  graph: nativeInvestigationGraphSchema,
  limitations: z.array(z.string()),
});

type InterfaceBuilderAnalysis = z.infer<typeof interfaceBuilderAnalysisSchema>;

export interface InterfaceBuilderDocumentInput {
  readonly relativePath: string;
  readonly archiveSha256: string;
  readonly documentKind: "nib" | "storyboard_scene";
  readonly raw: unknown;
}

type InvestigationNode = z.infer<typeof nativeInvestigationNodeSchema>;
type InvestigationEdge = z.infer<typeof nativeInvestigationEdgeSchema>;

/** Build the graph returned by the static Interface Builder archive decoder. */
export const buildInterfaceBuilderAnalysis = (input: {
  readonly targetSha256: string;
  readonly toolVersion: string;
  readonly documents: readonly InterfaceBuilderDocumentInput[];
  readonly limits: z.output<typeof interfaceBuilderLimitsSchema>;
}) => {
  const nodes = new Map<string, InvestigationNode>();
  const edges: InvestigationEdge[] = [];
  const coverage = [] as Array<{
    facet: string;
    status: "complete" | "partial" | "unsupported" | "not_requested";
    reason: string | null;
    examined: number;
    omitted: number;
  }>;
  const summaries: Array<z.infer<typeof interfaceBuilderDocumentSchema>> = [];
  let truncated = false;
  let omittedObjects = 0;
  let omittedConnections = 0;
  let omittedGraphNodes = 0;
  let omittedHierarchyReferences = 0;
  for (const document of input.documents.slice(0, input.limits.max_documents)) {
    const parsed = parseInterfaceBuilderRecords(document.raw);
    const prefix = `ib:${document.relativePath}:`;
    const rootId = `${prefix}root`;
    const objectIds = new Set(parsed.objects.map(({ id }) => id));
    const evidenceFor = (description: string) => [
      {
        kind: "interface_builder_resource" as const,
        // artifact_path names the archive; repeating it here cost a path per
        // node and edge.
        description,
        location: { address: null, file_offset: null },
        artifact_path: document.relativePath,
        artifact_sha256: document.archiveSha256,
      },
    ];
    const addNode = (node: InvestigationNode): boolean => {
      if (nodes.has(node.id)) return true;
      if (nodes.size >= input.limits.max_objects) {
        truncated = true;
        omittedGraphNodes += 1;
        return false;
      }
      nodes.set(node.id, node);
      return true;
    };
    const rootNode = {
      id: rootId,
      kind:
        document.documentKind === "nib"
          ? ("scene" as const)
          : ("storyboard" as const),
      name: document.relativePath,
      location: null,
      attributes: { document_kind: document.documentKind },
      evidence: evidenceFor("compiled document"),
    };
    addNode(rootNode);
    let documentObjectCount = 0;
    for (const object of parsed.objects.slice(0, input.limits.max_objects)) {
      const id = `${prefix}object:${object.id}`;
      const kind = object.kind === "other" ? "unknown" : object.kind;
      if (
        !addNode({
          id,
          kind,
          name: object.name,
          location: null,
          attributes: {
            ...object.attributes,
            interface_builder_object_id: object.id,
            class_name: object.class_name,
          },
          evidence: evidenceFor(`object ${object.id}`),
        })
      ) {
        break;
      }
      documentObjectCount += 1;
    }
    let connectionEdgeCount = 0;
    let hierarchyEdgeCount = 0;
    let documentOmittedConnections = 0;
    let documentOmittedHierarchyEdges = 0;
    const objectNodeId = (objectId: string): string =>
      `${prefix}object:${objectId}`;
    const addEdge = (
      edge: (typeof edges)[number],
      isHierarchy: boolean,
    ): void => {
      if (
        isHierarchy
          ? hierarchyEdgeCount >= input.limits.max_objects
          : connectionEdgeCount >= input.limits.max_connections * 3
      ) {
        truncated = true;
        if (isHierarchy) {
          documentOmittedHierarchyEdges += 1;
        } else {
          omittedConnections += 1;
          documentOmittedConnections += 1;
        }
        return;
      }
      edges.push(edge);
      if (isHierarchy) hierarchyEdgeCount += 1;
      else connectionEdgeCount += 1;
    };
    const connect = (
      id: string,
      from: string,
      to: string | null,
      relation: "contains" | "outlet_to" | "target_action" | "segue_to",
      description: string,
      reason?: string,
    ) => {
      if (!nodes.has(from)) {
        truncated = true;
        if (relation === "contains" && id.includes(":hierarchy:")) {
          documentOmittedHierarchyEdges += 1;
        } else {
          omittedConnections += 1;
          documentOmittedConnections += 1;
        }
        return;
      }
      const evidence = evidenceFor(description);
      const unresolvedEndpoint = to !== null && !nodes.has(to);
      if (unresolvedEndpoint) truncated = true;
      const edgeTo = unresolvedEndpoint ? null : to;
      const edgeReason = unresolvedEndpoint
        ? "endpoint_omitted_by_object_limit"
        : (reason ?? "destination_unresolved");
      addEdge(
        edgeTo === null
          ? {
              id,
              from,
              to: null,
              relation,
              resolution: "unresolved",
              reason: edgeReason,
              evidence,
              limitations: [],
            }
          : {
              id,
              from,
              to: edgeTo,
              relation,
              resolution: "observed",
              evidence,
              limitations: [],
            },
        relation === "contains" && id.includes(":hierarchy:"),
      );
    };
    let hierarchyCount = 0;
    let hierarchyTruncated = false;
    const visitHierarchy = (
      initial: unknown,
      initialParentId: string,
    ): void => {
      const pending: { readonly value: unknown; readonly parentId: string }[] =
        [{ value: initial, parentId: initialParentId }];
      while (pending.length > 0) {
        if (hierarchyCount >= input.limits.max_objects) {
          truncated = true;
          hierarchyTruncated = true;
          return;
        }
        const entry = pending.pop();
        if (entry === undefined) break;
        const { value, parentId } = entry;
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) {
            const child = value[index];
            if (child !== undefined) pending.push({ value: child, parentId });
          }
          continue;
        }
        if (typeof value !== "object" || value === null) continue;
        const item = record(value);
        const objectId = firstString(
          item.objectID,
          item["object-id"],
          item.id,
          typeof item.archiveUID === "number" ? String(item.archiveUID) : null,
        );
        let nextParent = parentId;
        if (objectId !== null) {
          const known = objectIds.has(objectId);
          const childId = known
            ? objectNodeId(objectId)
            : `${prefix}unknown:${objectId}`;
          if (
            !known &&
            !addNode({
              id: childId,
              kind: "unknown",
              name: firstString(item.label, item.name) ?? objectId,
              location: null,
              attributes: { interface_builder_object_id: objectId },
              evidence: evidenceFor(`hierarchy item ${objectId}`),
            })
          )
            hierarchyTruncated = true;
          connect(
            `${prefix}hierarchy:${parentId}:${childId}`,
            parentId,
            childId,
            "contains",
            `hierarchy ${objectId}`,
          );
          nextParent = childId;
          hierarchyCount += 1;
        }
        pending.push({ value: item.children, parentId: nextParent });
      }
    };
    for (const hierarchy of parsed.hierarchy) visitHierarchy(hierarchy, rootId);
    for (const [index, item] of parsed.connections
      .slice(0, input.limits.max_connections)
      .entries()) {
      const sourceId = objectNodeId(item.source_id);
      if (!nodes.has(sourceId))
        addNode({
          id: sourceId,
          kind: "unknown",
          name: item.source_id,
          location: null,
          attributes: { interface_builder_object_id: item.source_id },
          evidence: evidenceFor(`connection source ${item.source_id}`),
        });
      const destinationId =
        item.destination_id === null ? null : objectNodeId(item.destination_id);
      if (item.kind === "action") {
        const actionId = `${prefix}action:${item.id}`;
        const selectorId =
          item.label === null
            ? null
            : `${prefix}selector:${item.destination_id ?? "unknown"}:${item.label}`;
        addNode({
          id: actionId,
          kind: "action",
          name: item.label ?? "unlabeled action",
          location: null,
          attributes: {
            selector: item.label,
            destination_id: item.destination_id,
            ...item.attributes,
          },
          evidence: evidenceFor(`action ${item.id}`),
        });
        connect(
          `${actionId}:source`,
          sourceId,
          actionId,
          "target_action",
          `action source ${item.source_id}`,
        );
        if (selectorId !== null) {
          addNode({
            id: selectorId,
            kind: "objc_selector",
            name: item.label ?? "unknown selector",
            location: null,
            attributes: { destination_id: item.destination_id },
            evidence: evidenceFor(`selector ${item.label}`),
          });
          connect(
            `${actionId}:selector`,
            actionId,
            selectorId,
            "target_action",
            `selector ${item.label}`,
          );
        }
        if (destinationId === null || !nodes.has(destinationId))
          connect(
            `${actionId}:destination`,
            actionId,
            null,
            "target_action",
            `action destination ${item.destination_id ?? "missing"}`,
            "destination_object_missing_or_external",
          );
        else
          connect(
            `${actionId}:destination`,
            actionId,
            destinationId,
            "target_action",
            `action destination ${item.destination_id}`,
          );
      } else if (item.kind === "outlet") {
        const outletId = `${prefix}outlet:${item.id}`;
        addNode({
          id: outletId,
          kind: "outlet",
          name: item.label ?? item.id,
          location: null,
          attributes: item.attributes,
          evidence: evidenceFor(`outlet ${item.id}`),
        });
        connect(
          `${outletId}:source`,
          sourceId,
          outletId,
          "contains",
          `outlet source ${item.source_id}`,
        );
        if (destinationId === null || !nodes.has(destinationId))
          connect(
            `${outletId}:destination`,
            outletId,
            null,
            "outlet_to",
            `outlet ${item.label ?? item.id}`,
            "destination_object_missing_or_external",
          );
        else
          connect(
            `${outletId}:destination`,
            outletId,
            destinationId,
            "outlet_to",
            `outlet ${item.label ?? item.id}`,
          );
      } else if (item.kind === "segue") {
        if (destinationId === null || !nodes.has(destinationId))
          connect(
            `${prefix}segue:${index}`,
            sourceId,
            null,
            "segue_to",
            `segue ${item.label ?? item.id}`,
            "destination_scene_missing",
          );
        else
          connect(
            `${prefix}segue:${index}`,
            sourceId,
            destinationId,
            "segue_to",
            `segue ${item.label ?? item.id}`,
          );
      } else {
        connect(
          `${prefix}unknown-connection:${index}`,
          sourceId,
          null,
          "contains",
          `connection type ${item.kind}`,
          "unsupported_connection_type",
        );
      }
    }
    const objectsTruncated =
      parsed.omittedObjects > 0 || parsed.objects.length > documentObjectCount;
    const parserOmittedHierarchyReferences = parsed.omittedHierarchyReferences;
    omittedHierarchyReferences += parserOmittedHierarchyReferences;
    const parserOmittedConnections = parsed.omittedConnections;
    const connectionsTruncated =
      parserOmittedConnections > 0 ||
      parsed.connections.length > input.limits.max_connections;
    omittedObjects +=
      parsed.omittedObjects +
      Math.max(0, parsed.objects.length - documentObjectCount);
    omittedConnections +=
      Math.max(0, parsed.connections.length - input.limits.max_connections) +
      parserOmittedConnections;
    summaries.push({
      relative_path: document.relativePath,
      archive_sha256: document.archiveSha256,
      document_kind: document.documentKind,
      object_count: parsed.objectCount,
      connection_count: parsed.connections.length + parserOmittedConnections,
      hierarchy_complete:
        parsed.hierarchy.length > 0 &&
        !truncated &&
        parserOmittedHierarchyReferences === 0,
    });
    coverage.push(
      {
        facet: `objects:${document.relativePath}`,
        status: objectsTruncated ? "partial" : "complete",
        reason: objectsTruncated ? "object_limit_reached" : null,
        examined: documentObjectCount,
        omitted:
          parsed.omittedObjects +
          Math.max(0, parsed.objects.length - documentObjectCount),
      },
      {
        facet: `connections:${document.relativePath}`,
        status:
          connectionsTruncated || documentOmittedConnections > 0
            ? "partial"
            : "complete",
        reason:
          connectionsTruncated || documentOmittedConnections > 0
            ? "connection_limit_reached"
            : null,
        examined: Math.min(
          parsed.connections.length,
          input.limits.max_connections,
        ),
        omitted:
          Math.max(
            0,
            parsed.connections.length - input.limits.max_connections,
          ) +
          documentOmittedConnections +
          parserOmittedConnections,
      },
      {
        facet: `hierarchy:${document.relativePath}`,
        status:
          parserOmittedHierarchyReferences > 0
            ? "partial"
            : parsed.hierarchy.length === 0
              ? "unsupported"
              : hierarchyTruncated || documentOmittedHierarchyEdges > 0
                ? "partial"
                : "complete",
        reason:
          parserOmittedHierarchyReferences > 0
            ? "archive_hierarchy_references_missing"
            : parsed.hierarchy.length === 0
              ? "archive_hierarchy_not_decoded"
              : hierarchyTruncated || documentOmittedHierarchyEdges > 0
                ? "graph_limit_reached"
                : null,
        examined: hierarchyCount,
        omitted:
          documentOmittedHierarchyEdges + parserOmittedHierarchyReferences,
      },
      {
        facet: `classes:${document.relativePath}`,
        status:
          Object.keys(parsed.classes).length > 0 ? "complete" : "unsupported",
        reason:
          Object.keys(parsed.classes).length > 0
            ? null
            : "archive_class_table_not_decoded",
        examined: Object.keys(parsed.classes).length,
        omitted: 0,
      },
    );
  }
  if (input.documents.length > input.limits.max_documents) {
    truncated = true;
    coverage.push({
      facet: "documents",
      status: "partial",
      reason: "document_limit_reached",
      examined: input.limits.max_documents,
      omitted: input.documents.length - input.limits.max_documents,
    });
  }
  if (omittedGraphNodes > 0)
    coverage.push({
      facet: "graph_nodes",
      status: "partial",
      reason: "max_objects_reached",
      examined: nodes.size,
      omitted: omittedGraphNodes,
    });
  return interfaceBuilderAnalysisSchema.parse({
    target_sha256: input.targetSha256,
    documents: summaries,
    graph: {
      target_sha256: input.targetSha256,
      provider: {
        id: "rea-artifact-graph",
        version: "1",
        tool_version: input.toolVersion,
      },
      nodes: [...nodes.values()],
      edges,
      coverage,
      truncated:
        truncated ||
        omittedObjects > 0 ||
        omittedConnections > 0 ||
        omittedHierarchyReferences > 0,
    },
    limitations: [
      "The graph reflects recognized Interface Builder archive fields and connections; omitted private or unrecognized archive fields remain unknown.",
      "A target-action selector is an Interface Builder observation and does not prove that the binary contains a matching implementation.",
      "Decoded constraints, runtime visibility, dynamic UI creation, and pixel geometry are not inferred from these archives.",
    ],
  });
};

/** Hard limits shared by Interface Builder archive aggregation and tracing. */
export const interfaceBuilderLimitsSchema = z.strictObject({
  max_documents: z.number().int().min(1).max(64).default(64),
  max_objects: z.number().int().min(1).max(20_000).default(20_000),
  max_connections: z.number().int().min(1).max(40_000).default(40_000),
  trace: nativeInvestigationTraceLimitsSchema.default({
    max_depth: 8,
    max_nodes: 250,
    max_edges: 500,
  }),
});
