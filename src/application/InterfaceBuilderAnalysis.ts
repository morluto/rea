import { createHash } from "node:crypto";
import { parseBinary } from "plist";

import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
import { projectPlistValue } from "../domain/plistValue.js";
import {
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../domain/propertyListKeys.js";
import {
  decodeNibArchive,
  type NibArchiveDocument,
} from "../artifacts/NibArchive.js";
import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import {
  buildInterfaceBuilderAnalysis,
  interfaceBuilderLimitsSchema,
  type InterfaceBuilderDocumentInput,
} from "../domain/interfaceBuilderGraph.js";
import {
  mergeNibHierarchies,
  projectNibViewHierarchy,
  type NibHierarchyNode,
} from "./NibViewHierarchy.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/** Decode compiled Interface Builder archives from a local app bundle. */
export const analyzeInterfaceBuilderBundle = async (input: {
  readonly bundlePath: string;
  readonly targetSha256: string;
  readonly limits?: unknown;
  readonly signal?: AbortSignal;
}) => {
  const limits = interfaceBuilderLimitsSchema.parse(input.limits ?? {});
  const reader = new DirectoryArtifactReader(input.bundlePath);
  const documents: InterfaceBuilderDocumentInput[] = [];
  const invalid: string[] = [];
  const incompleteHierarchies = new Map<string, number>();
  const prototypeKeyOmissions = new Map<string, number>();
  let omitted = 0;
  let attempted = 0;
  try {
    for await (const entry of reader.entries(input.signal)) {
      if (entry.kind !== "file" || !isInterfaceBuilderArchive(entry.path))
        continue;
      if (attempted >= limits.max_documents) {
        omitted += 1;
        continue;
      }
      attempted += 1;
      try {
        const bytes = await readEntry(reader, entry, input.signal);
        const nib =
          bytes.subarray(0, 10).toString("ascii") === "NIBArchive"
            ? projectNibArchive(decodeNibArchive(bytes))
            : null;
        const { value: raw, omittedPrototypeKeys } =
          nib === null
            ? decodePlist(bytes)
            : { value: nib.raw, omittedPrototypeKeys: 0 };
        if (nib !== null && nib.omitted > 0)
          incompleteHierarchies.set(entry.path, nib.omitted);
        if (omittedPrototypeKeys > 0)
          prototypeKeyOmissions.set(entry.path, omittedPrototypeKeys);
        const documentHash = createHash("sha256").update(bytes).digest("hex");
        documents.push({
          relativePath: entry.path,
          archiveSha256: documentHash,
          documentKind: entry.path.includes(".storyboardc/")
            ? "storyboard_scene"
            : "nib",
          raw,
        });
      } catch (cause: unknown) {
        if (input.signal?.aborted === true) throw cause;
        invalid.push(
          `${entry.path}: ${cause instanceof Error ? cause.message : "archive decode failed"}`,
        );
      }
    }
  } finally {
    await reader.close();
  }
  const result = buildInterfaceBuilderAnalysis({
    targetSha256: input.targetSha256,
    toolVersion: "rea-interface-builder/1",
    documents,
    limits,
  });
  return finalizeHierarchyCoverage(result, {
    incompleteHierarchies,
    prototypeKeyOmissions,
    invalid,
    attempted,
    omitted,
  });
};

const finalizeHierarchyCoverage = (
  result: ReturnType<typeof buildInterfaceBuilderAnalysis>,
  counts: {
    incompleteHierarchies: ReadonlyMap<string, number>;
    prototypeKeyOmissions: ReadonlyMap<string, number>;
    invalid: readonly string[];
    attempted: number;
    omitted: number;
  },
) => {
  const { incompleteHierarchies, prototypeKeyOmissions, invalid } = counts;
  const archiveDecodePartial =
    invalid.length > 0 || prototypeKeyOmissions.size > 0;
  return {
    ...result,
    documents: result.documents.map((document) => ({
      ...document,
      hierarchy_complete:
        document.hierarchy_complete &&
        !incompleteHierarchies.has(document.relative_path),
    })),
    graph: {
      ...result.graph,
      coverage: [
        ...result.graph.coverage.map((facet) => {
          const omitted = incompleteHierarchies.get(
            facet.facet.replace(/^hierarchy:/u, ""),
          );
          return facet.facet.startsWith("hierarchy:") && omitted !== undefined
            ? {
                ...facet,
                status: "partial" as const,
                reason: "serialized_view_hierarchy_incomplete",
                omitted: facet.omitted + omitted,
              }
            : facet;
        }),
        {
          facet: "archive_decode",
          status: archiveDecodePartial
            ? ("partial" as const)
            : ("complete" as const),
          reason:
            invalid.length > 0
              ? "one_or_more_archives_invalid"
              : prototypeKeyOmissions.size > 0
                ? "dictionary_entries_omitted"
                : null,
          examined: counts.attempted,
          omitted: counts.omitted,
        },
      ],
      truncated:
        result.graph.truncated ||
        counts.omitted > 0 ||
        archiveDecodePartial ||
        incompleteHierarchies.size > 0,
    },
    limitations: [
      ...result.limitations,
      "Compiled Interface Builder archives are private serialized object graphs. The decoder reports only recognized keyed-archive objects and connections; unrecognized object classes and fields remain unknown.",
      ...(incompleteHierarchies.size === 0
        ? []
        : [
            "Some serialized hierarchy links could not be projected within the bounded hierarchy; their parentage remains unknown.",
          ]),
      ...(invalid.length === 0
        ? []
        : [
            `Some Interface Builder archives could not be decoded: ${invalid.slice(0, 16).join("; ")}`,
          ]),
      ...[...prototypeKeyOmissions].map(
        ([path, count]) => `${path}: ${omittedPrototypeKeysLimitation(count)}`,
      ),
    ],
  };
};

/** Project decoded NIB records into the same bounded graph input as ibtool. */
const projectNibArchive = (archive: NibArchiveDocument) => {
  const byId = new Map(archive.objects.map((object) => [object.id, object]));
  const dereference = (value: JsonValue | undefined): JsonValue | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return value;
    const ref = value.$nib_object_ref;
    if (typeof ref !== "number") return value;
    const target = byId.get(ref);
    if (target === undefined) return undefined;
    if (target.class_name.replace(/\0+$/u, "") === "NSString") {
      const data = target.values["NS.bytes"];
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        const encoded = data.$nib_data_base64;
        if (typeof encoded === "string")
          return Buffer.from(encoded, "base64").toString("utf8");
      }
    }
    return { objectID: String(ref) };
  };
  const referencedString = (value: JsonValue | undefined): string | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const ref = value.$nib_object_ref;
    if (typeof ref !== "number") return null;
    const target = byId.get(ref);
    const data = target?.values["NS.bytes"];
    if (target?.class_name.replace(/\0+$/u, "") !== "NSString") return null;
    if (typeof data !== "object" || data === null || Array.isArray(data))
      return null;
    const encoded = data.$nib_data_base64;
    return typeof encoded === "string"
      ? Buffer.from(encoded, "base64").toString("utf8")
      : null;
  };
  const runtimeClass = (objectId: number): string | null => {
    const object = byId.get(objectId);
    if (object === undefined) return null;
    const storedClass = object.class_name.replace(/\0+$/u, "");
    if (storedClass === "NSClassSwapper")
      return referencedString(object.values.NSClassName) ?? storedClass;
    return storedClass === "UIClassSwapper"
      ? (referencedString(object.values.UIClassName) ?? storedClass)
      : storedClass;
  };
  const objects = Object.fromEntries(
    archive.objects
      .filter((object) => {
        const name = runtimeClass(object.id) ?? "";
        return !/^(?:NSObject|NSIBObjectData|NSString|NSMutableString|NSNumber|NSArray|NSMutableArray|NSSet|NSMutableSet|NSDictionary|NSMutableDictionary|NSApplication|NSNib.*Connector|UIRuntime\w*Connection)$/u.test(
          name,
        );
      })
      .map((object) => {
        const className =
          runtimeClass(object.id) ?? object.class_name.replace(/\0+$/u, "");
        const strings = Object.entries(object.values).flatMap(
          ([key, value]) => {
            const resolved = dereference(value);
            return typeof resolved === "string" ? [[key, resolved]] : [];
          },
        );
        const name =
          strings.find(([key]) =>
            /(?:title|label|identifier|accessibility|name|contents)/iu.test(
              key ?? "",
            ),
          )?.[1] ?? className;
        return [
          String(object.id),
          {
            customClass: className,
            label: name,
            objectID: String(object.id),
            nibValues: Object.fromEntries(
              Object.entries(object.values).map(([key, value]) => [
                key,
                dereference(value) ?? null,
              ]),
            ),
          },
        ];
      }),
  );
  const connections: Record<string, JsonValue[]> = {};
  const hierarchy: NibHierarchyNode[] = [];
  const reference = (value: JsonValue | undefined): number | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    return typeof value.$nib_object_ref === "number"
      ? value.$nib_object_ref
      : null;
  };
  for (const object of archive.objects) {
    const className = object.class_name.replace(/\0+$/u, "");
    // AppKit connectors use NS-prefixed keys; UIKit's runtime outlet and
    // event connections use UI-prefixed keys with the same roles.
    const uiKit = /^UIRuntime\w*Connection$/u.test(className);
    if (!uiKit && !className.includes("Connector")) continue;
    const values = object.values;
    const source = reference(uiKit ? values.UISource : values.NSSource);
    if (source === null) continue;
    const destination = reference(
      uiKit ? values.UIDestination : values.NSDestination,
    );
    const label = referencedString(uiKit ? values.UILabel : values.NSLabel);
    const type = className.includes("Outlet")
      ? "outlet"
      : className.includes("Control") || className.includes("Event")
        ? "action"
        : className;
    const eventMask = values.UIEventMask;
    // The source is the outlet owner or the sending control; the destination
    // is the outlet value or the action target, and a nil target is the
    // first responder.
    (connections[String(source)] ??= []).push({
      type,
      "destination-id": destination === null ? null : String(destination),
      label,
      source_id: String(source),
      archive_object_id: String(object.id),
      ...(typeof eventMask === "number" ? { ui_event_mask: eventMask } : {}),
    });
  }
  let hierarchyOmitted = 0;
  const hierarchyFor = (
    objectId: number,
    seen: Set<number>,
    depth: number,
  ): NibHierarchyNode | null => {
    if (depth > 32 || seen.has(objectId)) {
      hierarchyOmitted += 1;
      return null;
    }
    const object = byId.get(objectId);
    if (object === undefined) {
      hierarchyOmitted += 1;
      return null;
    }
    const nextSeen = new Set(seen).add(objectId);
    const children: NibHierarchyNode[] = [];
    for (const [key, value] of Object.entries(object.values)) {
      if (!/(?:subviews|contentview|childviewcontrollers|view)$/iu.test(key))
        continue;
      const direct = reference(value);
      if (direct === null) continue;
      const target = byId.get(direct);
      if (target === undefined) {
        hierarchyOmitted += 1;
        continue;
      }
      if (/array|set/iu.test(target.class_name)) {
        for (const candidate of Object.values(target.values)) {
          const child = reference(candidate);
          const nested =
            child === null ? null : hierarchyFor(child, nextSeen, depth + 1);
          if (nested !== null) children.push(nested);
        }
      } else {
        const nested = hierarchyFor(direct, nextSeen, depth + 1);
        if (nested !== null) children.push(nested);
      }
    }
    return { objectID: String(objectId), children };
  };
  const ibData = archive.objects.find(
    ({ class_name }) => class_name.replace(/\0+$/u, "") === "NSIBObjectData",
  );
  const rootId = reference(ibData?.values.NSRoot);
  const hierarchyRoots = rootId === null ? [] : [rootId];
  for (const hierarchyRoot of hierarchyRoots) {
    const root = hierarchyFor(hierarchyRoot, new Set(), 0);
    if (root !== null) hierarchy.push(root);
  }
  const viewHierarchy = projectNibViewHierarchy(
    archive.objects,
    new Set(Object.keys(objects).map(Number)),
  );
  const merged = mergeNibHierarchies(hierarchy, viewHierarchy.hierarchy ?? []);
  return {
    omitted: viewHierarchy.omitted + hierarchyOmitted + merged.omitted,
    raw: jsonValueSchema.parse({
      "com.apple.ibtool.document.objects": objects,
      "com.apple.ibtool.document.connections": connections,
      "com.apple.ibtool.document.hierarchy": merged.hierarchy,
      "com.apple.ibtool.document.classes": Object.fromEntries(
        archive.classes.map((name) => [name.replace(/\0+$/u, ""), {}]),
      ),
    }),
  };
};

const isInterfaceBuilderArchive = (path: string): boolean => {
  const lower = path.toLowerCase();
  return lower.endsWith(".nib") || lower.endsWith("/objects.nib");
};

const readEntry = async (
  reader: DirectoryArtifactReader,
  entry: ArtifactEntry,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (entry.declaredSize !== null && entry.declaredSize > MAX_DOCUMENT_BYTES)
    throw new RangeError(
      "archive exceeds the 64 MiB per-document decode limit",
    );
  const stream = await reader.open(entry, signal);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > MAX_DOCUMENT_BYTES) {
      stream.destroy();
      throw new RangeError(
        "archive exceeded the 64 MiB per-document decode limit",
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
};

/** Project decoded plist data and dates while retaining omitted-key coverage. */
const decodePlist = (
  bytes: Buffer,
): { readonly value: JsonValue; readonly omittedPrototypeKeys: number } => {
  const { value, omittedPrototypeKeys } =
    bytes.subarray(0, 8).toString("ascii") === "bplist00"
      ? { value: parseBinary(bytes), omittedPrototypeKeys: 0 }
      : parseXmlPropertyList(bytes.toString("utf8"));
  return { value: projectPlistValue(value).value, omittedPrototypeKeys };
};
