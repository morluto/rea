import { createHash } from "node:crypto";
import { parseBinary } from "plist";

import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { projectPlistValue } from "../../domain/apple/plistValue.js";
import {
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../../domain/propertyListKeys.js";
import { decodeNibArchive, type NibArchiveDocument } from "./NibArchive.js";
import {
  estimatePropertyListDecodeBytes,
  InterfaceBuilderDecodeBudget,
  InterfaceBuilderDecodeBudgetExceeded,
} from "./InterfaceBuilderDecodeBudget.js";
import type { ArtifactEntry } from "../ArtifactReader.js";
import {
  buildInterfaceBuilderAnalysis,
  interfaceBuilderLimitsSchema,
  type InterfaceBuilderDocumentInput,
} from "../../domain/apple/interfaceBuilderGraph.js";
import {
  mergeNibHierarchies,
  projectNibViewHierarchy,
  type NibHierarchyNode,
} from "./NibViewHierarchy.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";

import { decodeXmlPlistText } from "../../domain/propertyListXmlText.js";

const MAX_AGGREGATE_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_AGGREGATE_DECODE_BYTES = 256 * 1024 * 1024;
const MAX_REPORTED_OMITTED_ARCHIVES = 64;

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
  const omittedArchives: Array<{ path: string; reason: string }> = [];
  let unreportedOmittedArchives = 0;
  const incompleteHierarchies = new Map<string, number>();
  const prototypeKeyOmissions = new Map<string, number>();
  let omitted = 0;
  let attempted = 0;
  let aggregateInputBytes = 0;
  const decodeBudget = new InterfaceBuilderDecodeBudget(
    MAX_AGGREGATE_DECODE_BYTES,
  );
  const recordOmittedArchive = (path: string, reason: string): void => {
    if (omittedArchives.length < MAX_REPORTED_OMITTED_ARCHIVES)
      omittedArchives.push({ path, reason });
    else unreportedOmittedArchives += 1;
  };
  try {
    const selection = await selectInterfaceBuilderCandidates(
      reader,
      input.signal,
      limits.max_documents,
    );
    omitted = selection.omitted;
    for (const entry of selection.omittedSamples)
      recordOmittedArchive(entry.path, "max_documents");
    unreportedOmittedArchives += selection.unreportedOmitted;
    for (const entry of selection.selected) {
      try {
        const remainingInputBytes =
          MAX_AGGREGATE_INPUT_BYTES - aggregateInputBytes;
        if (
          entry.declaredSize !== null &&
          entry.declaredSize > remainingInputBytes
        ) {
          omitted += 1;
          recordOmittedArchive(entry.path, "aggregate_decode_budget_exhausted");
          continue;
        }
        attempted += 1;
        const bytes = await readEntry(
          reader,
          entry,
          input.signal,
          remainingInputBytes,
        );
        aggregateInputBytes += bytes.length;
        const isNibArchive =
          bytes.subarray(0, 10).toString("ascii") === "NIBArchive";
        let nib: ReturnType<typeof projectNibArchive> | null = null;
        let xmlText: string | undefined;
        if (isNibArchive) {
          const documentBudget = new InterfaceBuilderDecodeBudget(
            decodeBudget.remainingBytes,
          );
          nib = projectNibArchive(
            decodeNibArchive(bytes, documentBudget),
            documentBudget,
            limits.max_objects,
          );
          decodeBudget.reserve(
            documentBudget.usedBytes,
            "NIBArchive representation exceeds the aggregate Interface Builder decode budget",
          );
        } else {
          if (bytes.subarray(0, 8).toString("ascii") !== "bplist00")
            xmlText = decodeXmlPlistText(bytes);
          const decodedReservation = estimatePropertyListDecodeBytes(
            bytes,
            decodeBudget.remainingBytes,
            xmlText,
          );
          decodeBudget.reserve(
            decodedReservation,
            "plist representation exceeds the aggregate Interface Builder decode budget",
          );
        }
        const { value: raw, omittedPrototypeKeys } =
          nib === null
            ? decodePlist(bytes, xmlText)
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
        if (cause instanceof InterfaceBuilderDecodeBudgetExceeded) {
          omitted += 1;
          recordOmittedArchive(entry.path, cause.reason);
          continue;
        }
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
    omittedArchives,
    unreportedOmittedArchives,
    attempted,
    omitted,
  });
};

/** Select lexically earliest document paths independent of host traversal order. */
const selectInterfaceBuilderCandidates = async (
  reader: DirectoryArtifactReader,
  signal: AbortSignal | undefined,
  maximumDocuments: number,
): Promise<{
  readonly selected: readonly ArtifactEntry[];
  readonly omittedSamples: readonly ArtifactEntry[];
  readonly omitted: number;
  readonly unreportedOmitted: number;
}> => {
  const capacity = maximumDocuments + MAX_REPORTED_OMITTED_ARCHIVES;
  const candidates: ArtifactEntry[] = [];
  let total = 0;
  for await (const entry of reader.entries(signal)) {
    if (entry.kind !== "file" || !isInterfaceBuilderArchive(entry.path))
      continue;
    total += 1;
    retainCandidate(candidates, entry, capacity);
  }
  const omittedSamples = candidates.slice(maximumDocuments, capacity);
  return {
    selected: candidates.slice(0, maximumDocuments),
    omittedSamples,
    omitted: Math.max(0, total - maximumDocuments),
    unreportedOmitted: Math.max(
      0,
      total - maximumDocuments - omittedSamples.length,
    ),
  };
};

/** Keep the earliest bounded path set; directory iteration order is host-defined. */
const retainCandidate = (
  candidates: ArtifactEntry[],
  entry: ArtifactEntry,
  maximum: number,
): void => {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const existing = candidates[middle];
    if (
      existing !== undefined &&
      compareUnicodeCodePoints(existing.path, entry.path) < 0
    )
      low = middle + 1;
    else high = middle;
  }
  candidates.splice(low, 0, entry);
  if (candidates.length > maximum) candidates.pop();
};

const finalizeHierarchyCoverage = (
  result: ReturnType<typeof buildInterfaceBuilderAnalysis>,
  counts: {
    incompleteHierarchies: ReadonlyMap<string, number>;
    prototypeKeyOmissions: ReadonlyMap<string, number>;
    invalid: readonly string[];
    omittedArchives: readonly { path: string; reason: string }[];
    unreportedOmittedArchives: number;
    attempted: number;
    omitted: number;
  },
) => {
  const {
    incompleteHierarchies,
    prototypeKeyOmissions,
    invalid,
    omittedArchives,
    unreportedOmittedArchives,
  } = counts;
  const archiveDecodePartial =
    invalid.length > 0 ||
    prototypeKeyOmissions.size > 0 ||
    omittedArchives.length > 0;
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
          reason: omittedArchives.some(
            ({ reason }) => reason === "aggregate_decode_budget_exhausted",
          )
            ? "aggregate_decode_budget_exhausted"
            : omittedArchives.some(({ reason }) => reason === "max_documents")
              ? "document_limit_reached"
              : omittedArchives.length > 0
                ? "archive_decode_budget_exhausted"
                : invalid.length > 0
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
      ...omittedArchives.map(
        ({ path, reason }) =>
          `${path}: omitted because ${reason.replaceAll("_", " ")}.`,
      ),
      ...(unreportedOmittedArchives === 0
        ? []
        : [
            `${unreportedOmittedArchives} additional omitted archive path(s) and their reasons were not retained; reporting is bounded to ${MAX_REPORTED_OMITTED_ARCHIVES} paths.`,
          ]),
    ],
  };
};

/** Project decoded NIB records into the same bounded graph input as ibtool. */
const projectNibArchive = (
  archive: NibArchiveDocument,
  budget: InterfaceBuilderDecodeBudget,
  maxHierarchyNodes: number,
) => {
  const byId = new Map(archive.objects.map((object) => [object.id, object]));
  const normalizedClassNames = new Map<string, string>();
  const normalizeClassName = (value: string): string => {
    const known = normalizedClassNames.get(value);
    if (known !== undefined) return known;
    const normalized = value.replace(/\0+$/u, "");
    normalizedClassNames.set(value, normalized);
    return normalized;
  };
  const decodedStrings = new Map<number, string | null>();
  const decodedString = (
    objectId: number,
    object: NibArchiveDocument["objects"][number],
  ): string | null => {
    if (decodedStrings.has(objectId))
      return decodedStrings.get(objectId) ?? null;
    const data = object.values["NS.bytes"];
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      decodedStrings.set(objectId, null);
      return null;
    }
    const encoded = data.$nib_data_base64;
    if (typeof encoded !== "string") {
      decodedStrings.set(objectId, null);
      return null;
    }
    budget.reserve(
      64 + encoded.length * 2,
      "NIBArchive string projection exceeds the aggregate Interface Builder decode budget",
    );
    const value = Buffer.from(encoded, "base64").toString("utf8");
    decodedStrings.set(objectId, value);
    return value;
  };
  let projectedFields = 0;
  for (const object of archive.objects)
    projectedFields += Object.keys(object.values).length;
  budget.reserve(
    archive.objects.length * 128 + projectedFields * 128,
    "NIBArchive graph projection exceeds the aggregate Interface Builder decode budget",
  );
  budget.reserve(
    archive.classes.length * 96,
    "NIBArchive class projection exceeds the aggregate Interface Builder decode budget",
  );
  const dereference = (value: JsonValue | undefined): JsonValue | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return value;
    const encodedData = value.$nib_data_base64;
    if (typeof encodedData === "string") {
      budget.reserveBase64JsonStringOccurrence(encodedData);
      return value;
    }
    const ref = value.$nib_object_ref;
    if (typeof ref !== "number") return value;
    const target = byId.get(ref);
    if (target === undefined) return undefined;
    if (normalizeClassName(target.class_name) === "NSString") {
      const string = decodedString(ref, target);
      if (string !== null) {
        budget.reserveJsonStringOccurrence(string);
        return string;
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
    if (
      target === undefined ||
      normalizeClassName(target.class_name) !== "NSString"
    )
      return null;
    const string = decodedString(ref, target);
    if (string === null) return null;
    budget.reserveJsonStringOccurrence(string);
    return string;
  };
  const runtimeClasses = new Map<number, string | null>();
  const runtimeClass = (objectId: number): string | null => {
    if (runtimeClasses.has(objectId))
      return runtimeClasses.get(objectId) ?? null;
    const object = byId.get(objectId);
    if (object === undefined) return null;
    const storedClass = normalizeClassName(object.class_name);
    const resolvedClass =
      storedClass === "NSClassSwapper"
        ? (referencedString(object.values.NSClassName) ?? storedClass)
        : storedClass === "UIClassSwapper"
          ? (referencedString(object.values.UIClassName) ?? storedClass)
          : storedClass;
    runtimeClasses.set(objectId, resolvedClass);
    return resolvedClass;
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
          runtimeClass(object.id) ?? normalizeClassName(object.class_name);
        budget.reserveJsonStringOccurrence(className);
        let name = className;
        for (const [key, value] of Object.entries(object.values)) {
          if (
            !/(?:title|label|identifier|accessibility|name|contents)/iu.test(
              key,
            )
          )
            continue;
          const resolved = dereference(value);
          if (typeof resolved !== "string") continue;
          name = resolved;
          break;
        }
        budget.reserveJsonStringOccurrence(name);
        return [
          String(object.id),
          {
            customClass: className,
            label: name,
            objectID: String(object.id),
            nibValues: Object.fromEntries(
              Object.entries(object.values).map(([key, value]) => {
                budget.reserveJsonPropertyNameOccurrence(key);
                return [key, dereference(value) ?? null];
              }),
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
    const className = normalizeClassName(object.class_name);
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
    budget.reserveJsonStringOccurrence(type);
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
  let hierarchyNodeCount = 0;
  const hierarchyFor = (
    objectId: number,
    seen: Set<number>,
    depth: number,
  ): NibHierarchyNode | null => {
    if (depth > 32 || seen.has(objectId)) {
      hierarchyOmitted += 1;
      return null;
    }
    if (hierarchyNodeCount >= maxHierarchyNodes) {
      hierarchyOmitted += 1;
      return null;
    }
    if (!budget.tryReserve(128)) {
      hierarchyOmitted += 1;
      return null;
    }
    const object = byId.get(objectId);
    if (object === undefined) {
      hierarchyOmitted += 1;
      return null;
    }
    hierarchyNodeCount += 1;
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
    ({ class_name }) => normalizeClassName(class_name) === "NSIBObjectData",
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
    () => budget.tryReserve(128),
    maxHierarchyNodes,
  );
  const merged = mergeNibHierarchies(
    hierarchy,
    viewHierarchy.hierarchy ?? [],
    () => budget.tryReserve(96),
    maxHierarchyNodes,
  );
  return {
    omitted: viewHierarchy.omitted + hierarchyOmitted + merged.omitted,
    raw: jsonValueSchema.parse({
      "com.apple.ibtool.document.objects": objects,
      "com.apple.ibtool.document.connections": connections,
      "com.apple.ibtool.document.hierarchy": merged.hierarchy,
      "com.apple.ibtool.document.classes": Object.fromEntries(
        archive.classes.map((name) => {
          const className = normalizeClassName(name);
          budget.reserveJsonPropertyNameOccurrence(className);
          return [className, {}];
        }),
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
  maxInputBytes = MAX_AGGREGATE_INPUT_BYTES,
): Promise<Buffer> => {
  if (entry.declaredSize !== null && entry.declaredSize > maxInputBytes)
    throw new InterfaceBuilderDecodeBudgetExceeded(
      "aggregate_decode_budget_exhausted",
      "archive exceeds the aggregate Interface Builder decode budget",
    );
  const stream = await reader.open(entry, signal);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > maxInputBytes) {
      stream.destroy();
      throw new InterfaceBuilderDecodeBudgetExceeded(
        "aggregate_decode_budget_exhausted",
        "archive exceeded the aggregate Interface Builder decode budget",
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
};

/** Project decoded plist data and dates while retaining omitted-key coverage. */
const decodePlist = (
  bytes: Buffer,
  xmlText?: string,
): { readonly value: JsonValue; readonly omittedPrototypeKeys: number } => {
  const { value, omittedPrototypeKeys } =
    bytes.subarray(0, 8).toString("ascii") === "bplist00"
      ? { value: parseBinary(bytes), omittedPrototypeKeys: 0 }
      : parseXmlPropertyList(xmlText ?? decodeXmlPlistText(bytes));
  return { value: projectPlistValue(value).value, omittedPrototypeKeys };
};
