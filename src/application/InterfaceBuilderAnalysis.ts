import { createHash } from "node:crypto";
import { parse, parseBinary } from "plist";

import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
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
        const raw =
          bytes.subarray(0, 10).toString("ascii") === "NIBArchive"
            ? projectNibArchive(decodeNibArchive(bytes))
            : decodePlist(bytes);
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
  return {
    ...result,
    graph: {
      ...result.graph,
      coverage: [
        ...result.graph.coverage,
        {
          facet: "archive_decode",
          status:
            invalid.length > 0 ? ("partial" as const) : ("complete" as const),
          reason: invalid.length > 0 ? "one_or_more_archives_invalid" : null,
          examined: attempted,
          omitted,
        },
      ],
      truncated: result.graph.truncated || omitted > 0 || invalid.length > 0,
    },
    limitations: [
      ...result.limitations,
      "Compiled Interface Builder archives are private serialized object graphs. The decoder reports only recognized keyed-archive objects and connections; unrecognized object classes and fields remain unknown.",
      ...(invalid.length === 0
        ? []
        : [
            `Some Interface Builder archives could not be decoded: ${invalid.slice(0, 16).join("; ")}`,
          ]),
    ],
  };
};

/** Project decoded NIB records into the same bounded graph input as ibtool. */
const projectNibArchive = (archive: NibArchiveDocument): JsonValue => {
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
    return storedClass === "NSClassSwapper"
      ? (referencedString(object.values.NSClassName) ?? storedClass)
      : storedClass;
  };
  const objects = Object.fromEntries(
    archive.objects
      .filter((object) => {
        const name = runtimeClass(object.id) ?? "";
        return !/^(?:NSObject|NSIBObjectData|NSString|NSMutableString|NSNumber|NSArray|NSMutableArray|NSSet|NSMutableSet|NSDictionary|NSMutableDictionary|NSApplication|NSNib.*Connector)$/u.test(
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
  const hierarchy: JsonValue[] = [];
  const reference = (value: JsonValue | undefined): number | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    return typeof value.$nib_object_ref === "number"
      ? value.$nib_object_ref
      : null;
  };
  for (const object of archive.objects) {
    const className = object.class_name.replace(/\0+$/u, "");
    const source = reference(object.values.NSSource);
    const destination = reference(object.values.NSDestination);
    if (className.includes("Connector") && source !== null) {
      const label = referencedString(object.values.NSLabel);
      const type = className.includes("Outlet")
        ? "outlet"
        : className.includes("Control")
          ? "action"
          : className;
      const controlAction = className.includes("Control");
      const connectionSource = controlAction ? destination : source;
      const connectionDestination = controlAction ? source : destination;
      if (connectionSource === null) continue;
      (connections[String(connectionSource)] ??= []).push({
        type,
        "destination-id":
          connectionDestination === null ? null : String(connectionDestination),
        label,
        source_id: String(connectionSource),
        archive_object_id: String(object.id),
      });
    }
  }
  const hierarchyFor = (
    objectId: number,
    seen: Set<number>,
    depth: number,
  ): JsonValue | null => {
    if (depth > 32 || seen.has(objectId)) return null;
    const object = byId.get(objectId);
    if (object === undefined) return null;
    const nextSeen = new Set(seen).add(objectId);
    const children: JsonValue[] = [];
    for (const [key, value] of Object.entries(object.values)) {
      if (!/(?:subviews|contentview|childviewcontrollers|view)$/iu.test(key))
        continue;
      const direct = reference(value);
      if (direct === null) continue;
      const target = byId.get(direct);
      if (target === undefined) continue;
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
  return jsonValueSchema.parse({
    "com.apple.ibtool.document.objects": objects,
    "com.apple.ibtool.document.connections": connections,
    "com.apple.ibtool.document.hierarchy": hierarchy,
    "com.apple.ibtool.document.classes": Object.fromEntries(
      archive.classes.map((name) => [name.replace(/\0+$/u, ""), {}]),
    ),
  });
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

const decodePlist = (bytes: Buffer): JsonValue => {
  const parsed =
    bytes.subarray(0, 8).toString("ascii") === "bplist00"
      ? parseBinary(bytes)
      : parse(bytes.toString("utf8"));
  return jsonValueSchema.parse(parsed);
};
