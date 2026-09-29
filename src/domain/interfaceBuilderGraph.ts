import { z } from "zod";

import {
  nativeInvestigationGraphSchema,
  nativeInvestigationTraceLimitsSchema,
} from "./nativeInvestigationGraph.js";
import { jsonValueSchema } from "./jsonValue.js";

const recordSchema = z.record(z.string(), z.unknown());

const objectNode = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([
    "view_controller",
    "view",
    "control",
    "constraint",
    "layout_guide",
    "resource",
    "placeholder",
    "external_object",
    "other",
  ]),
  class_name: z.string().nullable(),
  name: z.string().min(1),
  attributes: z.record(z.string(), jsonValueSchema),
});

const connection = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["outlet", "action", "segue", "other"]),
  source_id: z.string().min(1),
  destination_id: z.string().nullable(),
  label: z.string().nullable(),
  attributes: z.record(z.string(), jsonValueSchema),
});

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

export type InterfaceBuilderAnalysis = z.infer<
  typeof interfaceBuilderAnalysisSchema
>;

export type InterfaceBuilderObject = z.infer<typeof objectNode>;
export type InterfaceBuilderConnection = z.infer<typeof connection>;

export interface InterfaceBuilderDocumentInput {
  readonly relativePath: string;
  readonly archiveSha256: string;
  readonly documentKind: "nib" | "storyboard_scene";
  readonly raw: unknown;
}

/** Parse ibtool dictionaries or compiled keyed archives into typed records. */
export const parseInterfaceBuilderRecords = (
  value: unknown,
): {
  readonly objects: readonly InterfaceBuilderObject[];
  readonly connections: readonly InterfaceBuilderConnection[];
  readonly hierarchy: readonly unknown[];
  readonly classes: Readonly<Record<string, unknown>>;
} => {
  const root = record(value);
  const keyed = parseKeyedArchive(root);
  if (keyed !== null) return keyed;
  const objectsRaw = record(root["com.apple.ibtool.document.objects"]);
  const connectionsRaw = record(root["com.apple.ibtool.document.connections"]);
  const hierarchyRaw = root["com.apple.ibtool.document.hierarchy"];
  const classesRaw = record(root["com.apple.ibtool.document.classes"]);
  const objects: InterfaceBuilderObject[] = [];
  const connections: InterfaceBuilderConnection[] = [];
  for (const [id, raw] of Object.entries(objectsRaw).slice(0, 20_000)) {
    const attributes = record(raw);
    const className = firstString(
      attributes["customClass"],
      attributes["class"],
      attributes["isa"],
    );
    const label = firstString(
      attributes["label"],
      attributes["title"],
      attributes["name"],
      className,
    );
    objects.push(
      objectNode.parse({
        id,
        kind: classifyObject(className),
        class_name: className,
        name: label ?? id,
        attributes: jsonSafeRecord(attributes),
      }),
    );
  }
  for (const [sourceId, rawConnections] of Object.entries(connectionsRaw)) {
    if (!Array.isArray(rawConnections)) continue;
    for (const [index, raw] of rawConnections.entries()) {
      if (connections.length >= 40_000) break;
      const item = record(raw);
      const type = firstString(item.type, item.connectionType) ?? "unknown";
      const destination = firstString(
        item["destination-id"],
        item.destinationId,
      );
      const label = firstString(item.label, item.selector, item.identifier);
      connections.push(
        connection.parse({
          id: `${sourceId}:connection:${index}`,
          kind: classifyConnection(type),
          source_id: sourceId,
          destination_id: destination,
          label,
          attributes: jsonSafeRecord(item),
        }),
      );
    }
  }
  return {
    objects,
    connections,
    hierarchy: Array.isArray(hierarchyRaw) ? hierarchyRaw.slice(0, 20_000) : [],
    classes: classesRaw,
  };
};

/** Project class and connection objects from an NSKeyedArchiver object table. */
const parseKeyedArchive = (
  root: Record<string, unknown>,
): ReturnType<typeof parseInterfaceBuilderRecords> | null => {
  if (root.$archiver !== "NSKeyedArchiver" || !Array.isArray(root.$objects))
    return null;
  const objectTable = root.$objects;
  const resolve = (value: unknown, depth = 0): unknown => {
    if (depth > 16) return null;
    const uid = record(value).UID;
    if (typeof uid === "number") {
      const target = objectTable[uid];
      return target === undefined ? null : resolve(target, depth + 1);
    }
    if (Array.isArray(value))
      return value.map((item) => resolve(item, depth + 1));
    if (typeof value !== "object" || value === null) return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$class") {
        const classObject = record(
          typeof record(child).UID === "number"
            ? objectTable[record(child).UID as number]
            : child,
        );
        output.className = firstString(classObject.$classname);
      } else output[key] = resolve(child, depth + 1);
    }
    return output;
  };
  const objects: InterfaceBuilderObject[] = [];
  const connections: InterfaceBuilderConnection[] = [];
  for (const [index, raw] of objectTable.entries()) {
    if (index === 0) continue;
    const resolved = record(resolve(raw));
    const className = firstString(resolved.className);
    if (className === null) continue;
    const fields = Object.fromEntries(
      Object.entries(resolved).filter(([key]) => key !== "className"),
    );
    const authoredId = firstString(fields.objectID, fields["object-id"]);
    const objectId = authoredId ?? String(index);
    const kind = classifyObject(className);
    objects.push(
      objectNode.parse({
        id: objectId,
        kind,
        class_name: className,
        name:
          firstString(
            fields.label,
            fields.title,
            fields.identifier,
            fields.accessibilityLabel,
            className,
          ) ?? `object ${String(index)}`,
        attributes: jsonSafeRecord(fields),
      }),
    );
    if (/(?:Outlet|Connection|Segue|ActionConnection)/iu.test(className)) {
      const source = firstObjectReference(
        fields.source,
        fields.from,
        fields.owner,
      );
      if (source === null) continue;
      const kind = classifyConnection(className);
      connections.push(
        connection.parse({
          id: `archive:${objectId}`,
          kind,
          source_id: source,
          destination_id: firstObjectReference(
            fields.destination,
            fields.to,
            fields.target,
          ),
          label: firstString(
            fields.label,
            fields.selector,
            fields.identifier,
            fields.action,
          ),
          attributes: jsonSafeRecord(fields),
        }),
      );
    }
  }
  const top = record(root.$top);
  const topObject = record(resolve(top.root ?? top.UITopLevelObjectsKey));
  const hierarchy = Array.isArray(topObject) ? topObject : [];
  const classes = Object.fromEntries(
    objectTable.flatMap((raw) => {
      const item = record(raw);
      const name = firstString(item.$classname);
      return name === null
        ? []
        : [
            [
              name,
              {
                superclasses: Array.isArray(item.$classes) ? item.$classes : [],
              },
            ],
          ];
    }),
  );
  return { objects, connections, hierarchy, classes };
};

/** Build the graph returned by the static Interface Builder archive decoder. */
export const buildInterfaceBuilderAnalysis = (input: {
  readonly targetSha256: string;
  readonly toolVersion: string;
  readonly documents: readonly InterfaceBuilderDocumentInput[];
  readonly limits: z.output<typeof interfaceBuilderLimitsSchema>;
}) => {
  const nodes = new Map<
    string,
    z.infer<
      typeof import("./nativeInvestigationGraph.js").nativeInvestigationNodeSchema
    >
  >();
  const edges: z.infer<
    typeof import("./nativeInvestigationGraph.js").nativeInvestigationEdgeSchema
  >[] = [];
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
  for (const document of input.documents.slice(0, input.limits.max_documents)) {
    const parsed = parseInterfaceBuilderRecords(document.raw);
    const prefix = `ib:${document.relativePath}:`;
    const rootId = `${prefix}root`;
    const objectIds = new Set(parsed.objects.map(({ id }) => id));
    const evidenceFor = (description: string) => [
      {
        kind: "interface_builder_resource" as const,
        description: `${document.relativePath}: ${description}`,
        location: { address: null, file_offset: null },
        artifact_path: document.relativePath,
        artifact_sha256: document.archiveSha256,
      },
    ];
    const addNode = (
      node: z.infer<
        typeof import("./nativeInvestigationGraph.js").nativeInvestigationNodeSchema
      >,
    ): boolean => {
      if (nodes.has(node.id)) return true;
      if (nodes.size >= input.limits.max_objects) {
        truncated = true;
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
    const objectNodeId = (objectId: string): string =>
      `${prefix}object:${objectId}`;
    const addEdge = (edge: (typeof edges)[number]): void => {
      if (edges.length >= input.limits.max_connections * 3) {
        truncated = true;
        omittedConnections += 1;
        return;
      }
      edges.push(edge);
    };
    const connect = (
      id: string,
      from: string,
      to: string | null,
      relation: "contains" | "outlet_to" | "target_action" | "segue_to",
      description: string,
      reason?: string,
    ) => {
      const evidence = evidenceFor(description);
      addEdge(
        to === null
          ? {
              id,
              from,
              to: null,
              relation,
              resolution: "unresolved",
              reason: reason ?? "destination_unresolved",
              evidence,
              limitations: [],
            }
          : {
              id,
              from,
              to,
              relation,
              resolution: "observed",
              evidence,
              limitations: [],
            },
      );
    };
    let hierarchyCount = 0;
    let hierarchyTruncated = false;
    const visitHierarchy = (value: unknown, parentId: string): void => {
      if (hierarchyCount >= input.limits.max_objects) {
        truncated = true;
        hierarchyTruncated = true;
        return;
      }
      if (Array.isArray(value)) {
        for (const child of value) visitHierarchy(child, parentId);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const item = record(value);
      const objectId = firstString(item.objectID, item["object-id"], item.id);
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
      visitHierarchy(item.children, nextParent);
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
    const objectsTruncated = parsed.objects.length > documentObjectCount;
    const connectionsTruncated =
      parsed.connections.length > input.limits.max_connections;
    omittedObjects += Math.max(0, parsed.objects.length - documentObjectCount);
    omittedConnections += Math.max(
      0,
      parsed.connections.length - input.limits.max_connections,
    );
    summaries.push({
      relative_path: document.relativePath,
      archive_sha256: document.archiveSha256,
      document_kind: document.documentKind,
      object_count: parsed.objects.length,
      connection_count: parsed.connections.length,
      hierarchy_complete: parsed.hierarchy.length > 0 && !truncated,
    });
    coverage.push(
      {
        facet: `objects:${document.relativePath}`,
        status: objectsTruncated ? "partial" : "complete",
        reason: objectsTruncated ? "object_limit_reached" : null,
        examined: documentObjectCount,
        omitted: Math.max(0, parsed.objects.length - documentObjectCount),
      },
      {
        facet: `connections:${document.relativePath}`,
        status: connectionsTruncated ? "partial" : "complete",
        reason: connectionsTruncated ? "connection_limit_reached" : null,
        examined: Math.min(
          parsed.connections.length,
          input.limits.max_connections,
        ),
        omitted: Math.max(
          0,
          parsed.connections.length - input.limits.max_connections,
        ),
      },
      {
        facet: `hierarchy:${document.relativePath}`,
        status:
          parsed.hierarchy.length === 0
            ? "unsupported"
            : hierarchyTruncated
              ? "partial"
              : "complete",
        reason:
          parsed.hierarchy.length === 0
            ? "archive_hierarchy_not_decoded"
            : hierarchyTruncated
              ? "graph_limit_reached"
              : null,
        examined: hierarchyCount,
        omitted: 0,
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
      truncated: truncated || omittedObjects > 0 || omittedConnections > 0,
    },
    limitations: [
      "The graph reflects recognized Interface Builder archive fields and connections; omitted private or unrecognized archive fields remain unknown.",
      "A target-action selector is an Interface Builder observation and does not prove that the binary contains a matching implementation.",
      "Decoded constraints, runtime visibility, dynamic UI creation, and pixel geometry are not inferred from these archives.",
    ],
  });
};

const record = (value: unknown): Record<string, unknown> =>
  recordSchema.safeParse(value).data ?? {};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values)
    if (typeof value === "string" && value.length > 0) return value;
  return null;
};

const firstObjectReference = (...values: unknown[]): string | null => {
  for (const value of values) {
    const direct = firstString(value);
    if (direct !== null) return direct;
    const item = record(value);
    const objectId = firstString(
      item.objectID,
      item["object-id"],
      item.id,
      item.identifier,
    );
    if (objectId !== null) return objectId;
  }
  return null;
};

const classifyObject = (
  className: string | null,
): InterfaceBuilderObject["kind"] => {
  const value = className?.toLowerCase() ?? "";
  if (value.includes("constraint")) return "constraint";
  if (value.includes("layoutguide")) return "layout_guide";
  if (value.includes("placeholder") || value.includes("firstresponder"))
    return "placeholder";
  if (
    value.includes("image") ||
    value.includes("color") ||
    value.includes("font")
  )
    return "resource";
  if (value.includes("external")) return "external_object";
  if (value.includes("viewcontroller") || value.includes("windowcontroller"))
    return "view_controller";
  if (
    value.includes("button") ||
    value.includes("control") ||
    value.includes("textfield") ||
    value.includes("slider") ||
    value.includes("menuitem")
  )
    return "control";
  if (
    value.includes("view") ||
    value.includes("window") ||
    value.includes("cell")
  )
    return "view";
  return "other";
};

const classifyConnection = (
  type: string,
): InterfaceBuilderConnection["kind"] => {
  const value = type.toLowerCase();
  if (value.includes("outlet")) return "outlet";
  if (value.includes("action")) return "action";
  if (value.includes("segue")) return "segue";
  return "other";
};

const jsonSafeRecord = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      try {
        const serialized = JSON.stringify(item);
        if (serialized === undefined) return [];
        const parsed = jsonValueSchema.safeParse(JSON.parse(serialized));
        return parsed.success ? [[key, parsed.data]] : [];
      } catch {
        return [];
      }
    }),
  );

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
