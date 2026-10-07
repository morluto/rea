import { z } from "zod";

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

export type InterfaceBuilderObject = z.infer<typeof objectNode>;
export type InterfaceBuilderConnection = z.infer<typeof connection>;

/** Parse ibtool dictionaries or compiled keyed archives into typed records. */
export const parseInterfaceBuilderRecords = (
  value: unknown,
): {
  readonly objects: readonly InterfaceBuilderObject[];
  readonly connections: readonly InterfaceBuilderConnection[];
  readonly hierarchy: readonly unknown[];
  readonly classes: Readonly<Record<string, unknown>>;
  readonly objectCount: number;
  readonly omittedObjects: number;
  readonly omittedConnections: number;
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
  let omittedConnections = 0;
  const objectEntries = Object.entries(objectsRaw);
  for (const [id, raw] of objectEntries.slice(0, 20_000)) {
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
      if (connections.length >= 40_000) {
        omittedConnections += rawConnections.length - index;
        break;
      }
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
    objectCount: objectEntries.length,
    omittedObjects: Math.max(0, objectEntries.length - 20_000),
    omittedConnections,
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
      const resolved = target === undefined ? null : resolve(target, depth + 1);
      return typeof resolved === "object" &&
        resolved !== null &&
        !Array.isArray(resolved)
        ? { ...resolved, archiveUID: uid }
        : resolved;
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
  const toHierarchy = (value: unknown, depth = 0): unknown[] => {
    if (depth > 32) return [];
    if (Array.isArray(value))
      return value.flatMap((item) => toHierarchy(item, depth + 1));
    if (typeof value !== "object" || value === null) return [];
    const item = record(value);
    const objectId = firstString(
      item.objectID,
      item["object-id"],
      item.id,
      typeof item.archiveUID === "number" ? String(item.archiveUID) : null,
    );
    const children = Object.entries(item)
      .filter(([key]) =>
        /(?:subviews|contentview|childviewcontrollers|children|views)$/iu.test(
          key,
        ),
      )
      .flatMap(([, child]) => toHierarchy(child, depth + 1));
    return objectId === null ? children : [{ objectID: objectId, children }];
  };
  const objects: InterfaceBuilderObject[] = [];
  const connections: InterfaceBuilderConnection[] = [];
  let objectCount = 0;
  let omittedConnections = 0;
  for (const [index, raw] of objectTable.entries()) {
    if (index === 0) continue;
    const resolved = record(resolve(raw));
    const className = firstString(resolved.className);
    if (className === null) continue;
    objectCount += 1;
    const fields = Object.fromEntries(
      Object.entries(resolved).filter(([key]) => key !== "className"),
    );
    const authoredId = firstString(fields.objectID, fields["object-id"]);
    const objectId =
      authoredId ??
      (typeof fields.archiveUID === "number"
        ? String(fields.archiveUID)
        : String(index));
    const kind = classifyObject(className);
    if (objects.length < 20_000)
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
    if (
      /(?:Outlet|Connection|Segue|ActionConnection|ControlConnector)/iu.test(
        className,
      )
    ) {
      const controlAction = /ControlConnector/iu.test(className);
      const source = firstObjectReference(
        controlAction ? fields.destination : fields.source,
        controlAction ? fields.to : fields.from,
        controlAction ? fields.target : fields.owner,
      );
      if (source === null) continue;
      const kind = controlAction ? "action" : classifyConnection(className);
      const parsedConnection = connection.parse({
        id: `archive:${objectId}`,
        kind,
        source_id: source,
        destination_id: firstObjectReference(
          controlAction ? fields.source : fields.destination,
          controlAction ? fields.from : fields.to,
          controlAction ? fields.owner : fields.target,
        ),
        label: firstString(
          fields.label,
          fields.selector,
          fields.identifier,
          fields.action,
        ),
        attributes: jsonSafeRecord(fields),
      });
      if (connections.length < 40_000) connections.push(parsedConnection);
      else omittedConnections += 1;
    }
  }
  const top = record(root.$top);
  const topObject = resolve(top.root ?? top.UITopLevelObjectsKey);
  const hierarchy = toHierarchy(topObject);
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
  return {
    objects,
    connections,
    hierarchy,
    classes,
    objectCount,
    omittedObjects: Math.max(0, objectCount - 20_000),
    omittedConnections,
  };
};

/** Coerce unknown values to a string-keyed record; non-objects become `{}`. */
export const record = (value: unknown): Record<string, unknown> =>
  recordSchema.safeParse(value).data ?? {};

/** First non-empty string among the candidates, otherwise null. */
export const firstString = (...values: unknown[]): string | null => {
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
      typeof item.archiveUID === "number" ? String(item.archiveUID) : null,
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
      } catch (cause: unknown) {
        // Unserializable entries are omitted from the record.
        void cause;
        return [];
      }
    }),
  );
