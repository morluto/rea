import { z } from "zod";

import { jsonValueSchema } from "../jsonValue.js";

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

type InterfaceBuilderObject = z.infer<typeof objectNode>;
type InterfaceBuilderConnection = z.infer<typeof connection>;

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
  readonly omittedHierarchyReferences: number;
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
    // class_name, name, and id already carry these values; repeating them in
    // attributes doubled them on every graph node.
    const carried = new Set<string>();
    if (attributes["customClass"] === className) carried.add("customClass");
    if (attributes["label"] === label) carried.add("label");
    if (attributes["objectID"] === id) carried.add("objectID");
    objects.push(
      objectNode.parse({
        id,
        kind: classifyObject(className),
        class_name: className,
        name: label ?? id,
        attributes: jsonSafeRecord(
          Object.fromEntries(
            Object.entries(attributes).filter(([key]) => !carried.has(key)),
          ),
        ),
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
    omittedHierarchyReferences: 0,
  };
};

/**
 * A UID decodes as a one-key `UID` (binary) or `CF$UID` (XML) dictionary with
 * an integer value. Any other dictionary is ordinary archive data.
 */
const archiveUid = (value: unknown): number | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  if (Object.keys(value).length !== 1) return undefined;
  const item = record(value);
  const marker = Object.hasOwn(item, "UID") ? item.UID : item["CF$UID"];
  return typeof marker === "number" && Number.isInteger(marker)
    ? marker
    : undefined;
};

const HIERARCHY_KEY =
  /(?:subviews|contentview|childviewcontrollers|children|views)$/iu;

/**
 * Read an NSKeyedArchiver object table without expanding it into a tree.
 * Archived objects reference each other freely, including cycles such as a
 * view and its superview, so inlining every reference grows exponentially.
 * A reference instead resolves to the referenced string, or to a stub that
 * names the referenced object; the hierarchy walk visits each object once.
 */
const keyedArchiveTable = (objectTable: readonly unknown[]) => {
  const classNameOf = (value: unknown): string | null => {
    const classReference = record(value).$class;
    const uid = archiveUid(classReference);
    return firstString(
      record(uid === undefined ? classReference : objectTable[uid]).$classname,
    );
  };
  /** The string an archived string object holds, if it is one. */
  const archivedString = (target: unknown): string | undefined => {
    if (typeof target === "string") return target;
    const text = record(target)["NS.string"];
    return typeof text === "string" &&
      /^NS(?:Mutable)?String$/u.test(classNameOf(target) ?? "")
      ? text
      : undefined;
  };
  const text = (value: unknown): string | null => {
    const uid = archiveUid(value);
    return firstString(
      uid === undefined ? value : archivedString(objectTable[uid]),
    );
  };
  const authoredId = (item: Record<string, unknown>): string | null =>
    firstString(text(item.objectID), text(item["object-id"]));
  const reference = (uid: number): unknown => {
    // UID 0 is the archived nil.
    const target = uid === 0 ? null : objectTable[uid];
    if (target === undefined || target === null) return null;
    if (typeof target !== "object") return target;
    const string = archivedString(target);
    if (string !== undefined) return string;
    const objectId = authoredId(record(target));
    return {
      archiveUID: uid,
      ...(objectId === null ? {} : { objectID: objectId }),
      className: classNameOf(target),
    };
  };
  /** Resolve one object's own fields, leaving references to other objects as stubs. */
  const resolve = (value: unknown): unknown => {
    const uid = archiveUid(value);
    if (uid !== undefined) return reference(uid);
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value !== "object" || value === null) return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$class") output.className = classNameOf(value);
      else output[key] = resolve(child);
    }
    return output;
  };
  const hierarchy = (start: unknown) => {
    let omittedReferences = 0;
    const visited = new Set<number>();
    const root: unknown[] = [];
    const pending: { readonly value: unknown; readonly output: unknown[] }[] = [
      { value: start, output: root },
    ];
    const appendNode = (
      item: Record<string, unknown>,
      uid: number | undefined,
      output: unknown[],
    ): void => {
      const objectId = firstString(
        authoredId(item),
        text(item.id),
        uid === undefined ? null : String(uid),
      );
      if (objectId === null) {
        for (const [key, child] of Object.entries(item).reverse())
          if (HIERARCHY_KEY.test(key)) pending.push({ value: child, output });
        return;
      }
      const children: unknown[] = [];
      output.push({ objectID: objectId, children });
      for (const [key, child] of Object.entries(item).reverse())
        if (HIERARCHY_KEY.test(key))
          pending.push({ value: child, output: children });
    };
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined) break;
      const { value, output } = entry;
      const uid = archiveUid(value);
      if (uid !== undefined) {
        // UID0 is archived nil, not a missing hierarchy object.
        if (uid === 0) continue;
        const target = objectTable[uid];
        if (target === undefined) {
          omittedReferences += 1;
          continue;
        }
        if (visited.has(uid)) continue;
        visited.add(uid);
        if (Array.isArray(target)) {
          for (let index = target.length - 1; index >= 0; index -= 1) {
            const child = target[index];
            if (child !== undefined) pending.push({ value: child, output });
          }
          continue;
        }
        if (typeof target !== "object" || target === null) continue;
        const item = record(target);
        if (archivedArrayClass(item.$class)) {
          const members = item["NS.objects"];
          if (Array.isArray(members))
            for (let index = members.length - 1; index >= 0; index -= 1) {
              const child = members[index];
              if (child !== undefined) pending.push({ value: child, output });
            }
          continue;
        }
        appendNode(item, uid, output);
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const child = value[index];
          if (child !== undefined) pending.push({ value: child, output });
        }
      } else if (typeof value === "object" && value !== null) {
        appendNode(record(value), undefined, output);
      }
    }
    return { items: root, omittedReferences };
  };
  const archivedArrayClass = (classReference: unknown): boolean => {
    const uid = archiveUid(classReference);
    const descriptor = record(
      uid === undefined ? classReference : objectTable[uid],
    );
    const classNames = Array.isArray(descriptor.$classes)
      ? descriptor.$classes.filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    return (
      classNames.includes("NSArray") || classNames.includes("NSMutableArray")
    );
  };
  return { resolve, hierarchy };
};

/** Project class and connection objects from an NSKeyedArchiver object table. */
const parseKeyedArchive = (
  root: Record<string, unknown>,
): ReturnType<typeof parseInterfaceBuilderRecords> | null => {
  if (root.$archiver !== "NSKeyedArchiver" || !Array.isArray(root.$objects))
    return null;
  const objectTable: readonly unknown[] = root.$objects;
  const { resolve, hierarchy: toHierarchy } = keyedArchiveTable(objectTable);
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
      // AppKit connectors (NSNibOutletConnector, NSNibControlConnector)
      // archive NSSource as the outlet owner or sending control and
      // NSDestination as the outlet value or action target, so they are read
      // in that order without the inversion the unprefixed fields use.
      const source = firstObjectReference(
        controlAction ? fields.destination : fields.source,
        archivedObjectReference(fields.NSSource),
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
          archivedObjectReference(fields.NSDestination),
          controlAction ? fields.from : fields.to,
          controlAction ? fields.owner : fields.target,
        ),
        label: firstString(
          fields.label,
          fields.NSLabel,
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
  const hierarchy = toHierarchy(top.root ?? top.UITopLevelObjectsKey);
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
    hierarchy: hierarchy.items,
    classes,
    objectCount,
    omittedObjects: Math.max(0, objectCount - 20_000),
    omittedConnections,
    omittedHierarchyReferences: hierarchy.omittedReferences,
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

/**
 * The node identity of a resolved archive reference: its authored object ID,
 * otherwise its archive UID, which is how the referenced object's node is keyed.
 */
const archivedObjectReference = (value: unknown): string | null => {
  const item = record(value);
  if (typeof item.archiveUID !== "number") return null;
  return (
    firstString(item.objectID, item["object-id"]) ?? String(item.archiveUID)
  );
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
  if (
    value.includes("placeholder") ||
    value.includes("firstresponder") ||
    value === "uiproxyobject"
  )
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
