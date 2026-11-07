import { createHash } from "node:crypto";
import type { Element, Node } from "@xmldom/xmldom";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { streamChunkToBuffer } from "../artifacts/StreamBytes.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  ANDROID_APP_FUNCTION_SERVICE_ACTION,
  ANDROID_BIND_APP_FUNCTION_PERMISSION,
  type AndroidAppFunctionAssetCheckpoint,
  type AndroidAppFunctionEntry,
  type AndroidAppFunctionSchemaAsset,
  type AndroidAppFunctionSchemaPointer,
  type AndroidAppFunctionService,
  type AndroidAppFunctionsInventory,
} from "../domain/android/androidAppFunctions.js";
import type { ObservedAndroidManifestComponentInventory } from "../domain/android/androidManifestComponents.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { parseXmlDocument } from "../domain/xmlDocument.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import { isAndroidAttribute } from "./AndroidManifestXml.js";
import {
  JadxInterruption,
  throwIfJadxInterrupted,
} from "./JadxInterruption.js";

/** Bounds keep hostile APK archives and AppFunctions XML schemas strictly bounded. */
export const ANDROID_APP_FUNCTIONS_LIMITS = Object.freeze({
  apkEntries: 100_000,
  schemaAssets: 32,
  schemaAssetBytes: 1024 * 1024,
  totalSchemaBytes: 4 * 1024 * 1024,
  functionsPerSchema: 1024,
  totalFunctions: 2048,
  valueBytes: 256 * 1024,
  diagnosticBytes: 16 * 1024,
  perSchemaDiagnosticBytes: 4 * 1024,
  serviceLabelNameBytes: 128,
  serviceFactsBytes: 384 * 1024,
  schemaFactsBytes: 384 * 1024,
});

const APP_FUNCTION_ASSET_PATTERN =
  /^assets\/(?:.+\/)?[^/]*app[_-]?function[^/]*\.xml$/iu;

const STATIC_SCOPE_LIMITATION =
  "Static AppFunction declarations and XML schema assets do not establish runtime registration, caller authorization, or execution.";

const ENTRY_TAGS = new Set([
  "appfunction",
  "app_function",
  "appfunctionmetadata",
  "app-function",
]);
const CONTAINER_TAGS = new Set([
  "appfunctions",
  "app_functions",
  "appfunctionmetadatalist",
  "app-functions",
]);
const WRAPPER_TAGS = new Set(["items", "functions"]);
const METADATA_ONLY_TAGS = new Set([
  "version",
  "schema",
  "schemas",
  "metadata",
  "package",
  "package_name",
  "packagename",
]);
const NESTED_SCHEMA_TAGS = new Set([
  "schema",
  "schemametadata",
  "schema_metadata",
]);

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export interface AndroidAppFunctionAssetScan {
  readonly status: "complete" | "partial" | "unavailable";
  readonly examinedEntries: number;
  readonly schemas: readonly AndroidAppFunctionSchemaAsset[];
  readonly limitations: readonly string[];
}

const DIAGNOSTIC_OMISSION_RESERVE_BYTES = 160;
const MANIFEST_DIAGNOSTIC_BYTES = 12 * 1024;
const ASSET_SCAN_DIAGNOSTIC_BYTES = 3 * 1024;

const boundedDiagnosticToken = (raw: string, maxBytes = 256): string => {
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw;
  let bytes = 0;
  let end = 0;
  for (const char of raw) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return `${raw.slice(0, end)}...[truncated]`;
};

const createBoundedDiagnostics = (
  maxBytes: number = ANDROID_APP_FUNCTIONS_LIMITS.diagnosticBytes,
) => {
  const usableBudget = Math.max(
    0,
    maxBytes - DIAGNOSTIC_OMISSION_RESERVE_BYTES,
  );
  const items: string[] = [];
  let usedBytes = 0;
  let omitted = 0;
  return {
    pushParts: (parts: readonly string[]): void => {
      let candidateBytes = 0;
      for (const part of parts) {
        candidateBytes += Buffer.byteLength(part, "utf8");
        if (usedBytes + candidateBytes > usableBudget) {
          omitted += 1;
          return;
        }
      }
      usedBytes += candidateBytes;
      items.push(parts.join(""));
    },
    finish: (): string[] =>
      omitted === 0
        ? [...items]
        : [
            ...items,
            `${String(omitted)} additional AppFunctions diagnostic message(s) omitted after reaching the ${String(maxBytes)}-byte diagnostic allowance.`,
          ],
  };
};

const isAppFunctionsMetadataName = (name: string | null): name is string =>
  name !== null &&
  (name === "android.app.appfunctions" ||
    name.startsWith("android.app.appfunctions."));

const normalizeAppFunctionAssetPath = (raw: string): string | null => {
  if (
    raw.length === 0 ||
    raw !== raw.trim() ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.includes("\0")
  )
    return null;
  const normalized = raw.startsWith("assets/") ? raw : `assets/${raw}`;
  const segments = normalized.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    return null;
  return normalized;
};

/** Project AppFunctionService bindings and referenced asset paths from parsed manifest components. */
export const extractAndroidAppFunctionManifestBindings = (
  components: ObservedAndroidManifestComponentInventory,
): {
  readonly status: "complete" | "partial" | "unavailable";
  readonly services: readonly AndroidAppFunctionService[];
  readonly referencedAssetPaths: readonly string[];
  readonly limitations: readonly string[];
} => {
  if (components.status === "unavailable")
    return {
      status: "unavailable",
      services: [],
      referencedAssetPaths: [],
      limitations: [
        "Manifest component declarations are unavailable, so declared AppFunctionService bindings could not be established.",
      ],
    };
  let partial = components.status !== "complete";
  const diagnostics = createBoundedDiagnostics(MANIFEST_DIAGNOSTIC_BYTES);
  if (components.status === "partial")
    diagnostics.pushParts([
      "Manifest component coverage is partial, so declared AppFunctionService bindings may be incomplete.",
    ]);
  const services: AndroidAppFunctionService[] = [];
  const referencedSet = new Set<string>();
  let retainedServiceBytes = 0;
  for (const component of components.items) {
    if (component.kind !== "service") continue;
    const declaresServiceAction = component.actions.includes(
      ANDROID_APP_FUNCTION_SERVICE_ACTION,
    );
    const bindsSystemPermission =
      component.permission === ANDROID_BIND_APP_FUNCTION_PERMISSION;
    const rawPointers = [
      ...component.properties.map((item) => ["property", item] as const),
      ...component.meta_data.map((item) => ["meta-data", item] as const),
    ].filter(
      (
        entry,
      ): entry is readonly [
        "property" | "meta-data",
        (typeof entry)[1] & { readonly name: string },
      ] => isAppFunctionsMetadataName(entry[1].name),
    );
    if (
      !declaresServiceAction &&
      !bindsSystemPermission &&
      rawPointers.length === 0
    )
      continue;
    let namedServiceDiagnosticEmitted = false;
    const serviceSubject = (): readonly string[] => {
      if (
        !namedServiceDiagnosticEmitted &&
        Buffer.byteLength(component.name, "utf8") <=
          ANDROID_APP_FUNCTIONS_LIMITS.serviceLabelNameBytes
      ) {
        namedServiceDiagnosticEmitted = true;
        return [
          "Service ",
          component.name,
          " (declaration_index ",
          String(component.declaration_index),
          ")",
        ];
      }
      namedServiceDiagnosticEmitted = true;
      return [
        "Service at declaration_index ",
        String(component.declaration_index),
      ];
    };
    if (component.declaration_coverage !== "complete") {
      partial = true;
      diagnostics.pushParts([
        ...serviceSubject(),
        " has partial manifest declaration coverage; nested AppFunctions properties or metadata may be omitted.",
      ]);
    }
    const schemaPointers: AndroidAppFunctionSchemaPointer[] = [];
    let hasNonXmlCompanion = false;
    for (const [source, item] of rawPointers) {
      let resolvedAssetPath: string | null = null;
      const pointerName = boundedDiagnosticToken(item.name, 128);
      if (item.resource !== null) {
        partial = true;
        diagnostics.pushParts([
          ...serviceSubject(),
          " declares <",
          source,
          "> ",
          pointerName,
          ' with android:resource="',
          boundedDiagnosticToken(item.resource),
          '"; compiled @xml/... resource targets are not decoded from assets/.',
        ]);
      } else if (item.value !== null) {
        if (
          item.value.startsWith("@") ||
          item.value.startsWith("?") ||
          item.value.includes("${")
        ) {
          partial = true;
          diagnostics.pushParts([
            ...serviceSubject(),
            " declares <",
            source,
            "> ",
            pointerName,
            ' with "',
            boundedDiagnosticToken(item.value),
            '"; compiled @xml/... resource and placeholder targets are not decoded from assets/.',
          ]);
        } else {
          const normalized = normalizeAppFunctionAssetPath(item.value);
          if (normalized === null) {
            partial = true;
            diagnostics.pushParts([
              ...serviceSubject(),
              " declares <",
              source,
              "> ",
              pointerName,
              " with unsupported asset path ",
              JSON.stringify(boundedDiagnosticToken(item.value)),
              ".",
            ]);
          } else if (/\.xml$/iu.test(normalized)) {
            resolvedAssetPath = normalized;
            referencedSet.add(normalized);
          } else {
            hasNonXmlCompanion = true;
          }
        }
      } else {
        partial = true;
        diagnostics.pushParts([
          ...serviceSubject(),
          " declares <",
          source,
          "> ",
          pointerName,
          " without a retained android:value or android:resource target.",
        ]);
      }
      schemaPointers.push({
        source,
        name: item.name,
        value: item.value,
        resource: item.resource,
        resolved_asset_path: resolvedAssetPath,
        location: item.location,
      });
    }
    if (
      hasNonXmlCompanion &&
      !schemaPointers.some((pointer) => pointer.resolved_asset_path !== null)
    ) {
      partial = true;
      diagnostics.pushParts([
        ...serviceSubject(),
        " declares non-XML AppFunctions pointer(s) without an assets/*.xml target; only XML schema assets are parsed.",
      ]);
    }
    const serviceRecord: AndroidAppFunctionService = {
      declared_name: component.declared_name,
      name: component.name,
      declaration_index: component.declaration_index,
      location: component.location,
      exported: component.exported,
      permission: component.permission,
      binds_system_permission: bindsSystemPermission,
      declares_service_action: declaresServiceAction,
      schema_pointers: schemaPointers,
    };
    const recordBytes = jsonValueByteLength(
      serviceRecord as unknown as JsonValue,
      ANDROID_APP_FUNCTIONS_LIMITS.serviceFactsBytes,
    );
    if (
      retainedServiceBytes + recordBytes >
      ANDROID_APP_FUNCTIONS_LIMITS.serviceFactsBytes
    ) {
      partial = true;
      diagnostics.pushParts([
        "Declared AppFunctionService inventory reached the ",
        String(ANDROID_APP_FUNCTIONS_LIMITS.serviceFactsBytes),
        "-byte retained-facts allowance; remaining service declarations were omitted.",
      ]);
      break;
    }
    retainedServiceBytes += recordBytes;
    services.push(serviceRecord);
  }
  return {
    status: partial ? "partial" : "complete",
    services,
    referencedAssetPaths: [...referencedSet].sort(compareUnicodeCodePoints),
    limitations: diagnostics.finish(),
  };
};

const isXmlElement = (node: Node | null): node is Element =>
  node !== null && node.nodeType === 1;

const localTag = (element: Element): string =>
  (element.localName || element.nodeName).toLowerCase();

const directElementChildren = (element: Element): Element[] => {
  const result: Element[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (isXmlElement(child)) result.push(child);
  }
  return result;
};

const directTextContent = (element: Element): string => {
  let text = "";
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (child !== null && (child.nodeType === 3 || child.nodeType === 4))
      text += child.nodeValue ?? "";
  }
  return text;
};

const readEntryField = (
  element: Element,
  names: readonly string[],
): string | null => {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute === null) continue;
    if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:"))
      continue;
    if (
      attribute.namespaceURI !== null &&
      attribute.namespaceURI !== "" &&
      !isAndroidAttribute(attribute)
    )
      continue;
    const key = attribute.localName || attribute.name;
    if (names.includes(key)) {
      const trimmed = attribute.value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  for (const child of directElementChildren(element)) {
    const key = child.localName || child.nodeName;
    if (names.includes(key)) {
      const trimmed = directTextContent(child).trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
};

/** Parse one AppFunctions XML document with strict DTD/DOCTYPE rejection and copy budgets. */
export const parseAndroidAppFunctionXml = (
  xmlText: string,
  budgets: {
    valueBytesRemaining: number;
    functionsRemaining: number;
  } = {
    valueBytesRemaining: ANDROID_APP_FUNCTIONS_LIMITS.valueBytes,
    functionsRemaining: ANDROID_APP_FUNCTIONS_LIMITS.totalFunctions,
  },
): {
  readonly status: "complete" | "partial" | "unavailable";
  readonly functions: readonly AndroidAppFunctionEntry[];
  readonly limitations: readonly string[];
} => {
  const parsed = parseXmlDocument(xmlText, {
    doctype: "reject",
    lineEndings: "normalize",
  });
  if (!parsed.ok)
    return {
      status: "unavailable",
      functions: [],
      limitations: [
        parsed.error.reason === "doctype"
          ? "AppFunctions schema XML declares a DOCTYPE/DTD, which is rejected."
          : `AppFunctions schema XML is not well-formed (${parsed.error.reason}).`,
      ],
    };
  const root = parsed.value.documentElement;
  if (!isXmlElement(root))
    return {
      status: "unavailable",
      functions: [],
      limitations: ["AppFunctions schema XML has no root element."],
    };
  const rootTag = localTag(root);
  const candidates: Element[] = [];
  let unknownElements = 0;
  if (ENTRY_TAGS.has(rootTag)) {
    candidates.push(root);
  } else if (CONTAINER_TAGS.has(rootTag)) {
    for (const child of directElementChildren(root)) {
      const tag = localTag(child);
      if (ENTRY_TAGS.has(tag) || tag === "item") {
        candidates.push(child);
      } else if (WRAPPER_TAGS.has(tag)) {
        for (const nested of directElementChildren(child)) {
          const nestedTag = localTag(nested);
          if (ENTRY_TAGS.has(nestedTag) || nestedTag === "item")
            candidates.push(nested);
          else unknownElements += 1;
        }
      } else if (!METADATA_ONLY_TAGS.has(tag)) {
        unknownElements += 1;
      }
    }
  } else {
    const unsupported = createBoundedDiagnostics(
      ANDROID_APP_FUNCTIONS_LIMITS.perSchemaDiagnosticBytes,
    );
    unsupported.pushParts([
      "Root element <",
      boundedDiagnosticToken(root.nodeName, 128),
      "> is not a recognized AppFunctions schema container.",
    ]);
    return {
      status: "unavailable",
      functions: [],
      limitations: unsupported.finish(),
    };
  }
  let partial = false;
  let valueLimited = false;
  let functionCapReached = false;
  let nonliteralEnabled = 0;
  const take = (value: string | null): string | null => {
    if (value === null) return null;
    const bytes = Buffer.byteLength(value);
    if (bytes > budgets.valueBytesRemaining) {
      partial = true;
      valueLimited = true;
      return null;
    }
    budgets.valueBytesRemaining -= bytes;
    return value;
  };
  const functions: AndroidAppFunctionEntry[] = [];
  for (const entry of candidates) {
    if (
      functions.length >= ANDROID_APP_FUNCTIONS_LIMITS.functionsPerSchema ||
      budgets.functionsRemaining <= 0
    ) {
      partial = true;
      functionCapReached = true;
      break;
    }
    budgets.functionsRemaining -= 1;
    const schemaChild =
      directElementChildren(entry).find((child) =>
        NESTED_SCHEMA_TAGS.has(localTag(child)),
      ) ?? null;
    const rawId = readEntryField(entry, ["id", "function_id", "functionId"]);
    const rawSchemaName =
      readEntryField(entry, ["schema_name", "schemaName"]) ??
      (schemaChild === null
        ? null
        : readEntryField(schemaChild, ["schema_name", "schemaName", "name"]));
    const rawSchemaCategory =
      readEntryField(entry, ["schema_category", "schemaCategory"]) ??
      (schemaChild === null
        ? null
        : readEntryField(schemaChild, [
            "schema_category",
            "schemaCategory",
            "category",
          ]));
    const rawSchemaVersion =
      readEntryField(entry, ["schema_version", "schemaVersion"]) ??
      (schemaChild === null
        ? null
        : readEntryField(schemaChild, [
            "schema_version",
            "schemaVersion",
            "version",
          ]));
    const rawEnabled = readEntryField(entry, [
      "enabled_by_default",
      "enabledByDefault",
    ]);
    const enabledByDefault =
      rawEnabled === "true" ? true : rawEnabled === "false" ? false : null;
    if (rawEnabled !== null && enabledByDefault === null) {
      partial = true;
      nonliteralEnabled += 1;
    }
    functions.push({
      id: take(rawId),
      schema_name: take(rawSchemaName),
      schema_category: take(rawSchemaCategory),
      schema_version: take(rawSchemaVersion),
      enabled_by_default: enabledByDefault,
    });
  }
  const diagnostics = createBoundedDiagnostics(
    ANDROID_APP_FUNCTIONS_LIMITS.perSchemaDiagnosticBytes,
  );
  if (functionCapReached)
    diagnostics.pushParts([
      "Parsed AppFunction entries reached the ",
      String(ANDROID_APP_FUNCTIONS_LIMITS.functionsPerSchema),
      "-per-schema or ",
      String(ANDROID_APP_FUNCTIONS_LIMITS.totalFunctions),
      "-total limit.",
    ]);
  if (unknownElements > 0) {
    partial = true;
    diagnostics.pushParts([
      String(unknownElements),
      " unrecognized element(s) under <",
      boundedDiagnosticToken(root.nodeName, 128),
      "> were not projected as AppFunction entries.",
    ]);
  }
  if (nonliteralEnabled > 0)
    diagnostics.pushParts([
      String(nonliteralEnabled),
      " AppFunction entry/entries declare a nonliteral enabled_by_default value; enabled_by_default is null.",
    ]);
  if (valueLimited)
    diagnostics.pushParts([
      "Copied AppFunction string values reached the ",
      String(ANDROID_APP_FUNCTIONS_LIMITS.valueBytes),
      "-byte budget; omitted scalar fields are null.",
    ]);
  return {
    status: partial ? "partial" : "complete",
    functions,
    limitations: diagnostics.finish(),
  };
};

const readExactZipMemberBytes = async (
  reader: ZipArtifactReader,
  entry: ArtifactEntry,
  declaredSize: number,
  signal: AbortSignal,
): Promise<Buffer> => {
  const buffer = Buffer.alloc(declaredSize);
  let offset = 0;
  const stream = await reader.open(entry, signal);
  try {
    for await (const chunk of stream) {
      throwIfJadxInterrupted(signal);
      const part = streamChunkToBuffer(chunk);
      if (part.length > buffer.length - offset)
        throw new ArtifactReaderFailure(
          "integrity",
          "AppFunctions XML asset exceeds its declared ZIP size",
        );
      part.copy(buffer, offset);
      offset += part.length;
    }
  } finally {
    stream.destroy();
  }
  if (offset !== buffer.length)
    throw new ArtifactReaderFailure(
      "integrity",
      "AppFunctions XML asset is shorter than its declared ZIP size",
    );
  return buffer;
};

/** Inspect bundled AppFunctions XML schema assets from the immutable admitted APK snapshot. */
export const readAndroidAppFunctionAssets = async (input: {
  readonly snapshot: string;
  readonly referencedPaths: readonly string[];
  readonly resources: ArtifactResourceScope;
  readonly signal: AbortSignal;
  readonly interruption: (reason: unknown) => AnalysisError;
  readonly onObservation: (
    checkpoint: AndroidAppFunctionAssetCheckpoint,
  ) => void;
}): Promise<AndroidAppFunctionAssetScan> =>
  input.resources
    .run(async () => {
      const operation = "inspect_android_package";
      const reader = new ZipArtifactReader(
        input.snapshot,
        "apk",
        ANDROID_APP_FUNCTIONS_LIMITS.totalSchemaBytes,
      );
      const owner = {
        kind: "reader" as const,
        resource: input.snapshot,
        reader,
      };
      const referenced = new Set(input.referencedPaths);
      const seenPaths = new Set<string>();
      const duplicatePaths = new Set<string>();
      const schemas: AndroidAppFunctionSchemaAsset[] = [];
      const diagnostics = createBoundedDiagnostics(ASSET_SCAN_DIAGNOSTIC_BYTES);
      const budgets = {
        valueBytesRemaining: ANDROID_APP_FUNCTIONS_LIMITS.valueBytes,
        functionsRemaining: ANDROID_APP_FUNCTIONS_LIMITS.totalFunctions,
      };
      let status: "complete" | "partial" | "unavailable" = "complete";
      let exhaustedArchive = false;
      let archiveDegraded = false;
      let examinedEntries = 0;
      let totalReadBytes = 0;
      let retainedSchemaBytes = 0;
      let failed = false;
      let primary: unknown;
      let inProgress: AndroidAppFunctionSchemaAsset | undefined;
      const admitSchema = (asset: AndroidAppFunctionSchemaAsset): boolean => {
        const added = jsonValueByteLength(
          asset as unknown as JsonValue,
          ANDROID_APP_FUNCTIONS_LIMITS.schemaFactsBytes,
        );
        if (
          retainedSchemaBytes + added >
          ANDROID_APP_FUNCTIONS_LIMITS.schemaFactsBytes
        ) {
          status = "partial";
          diagnostics.pushParts([
            "Bundled AppFunctions schema inventory reached the ",
            String(ANDROID_APP_FUNCTIONS_LIMITS.schemaFactsBytes),
            "-byte retained-facts allowance; remaining schema assets were omitted.",
          ]);
          return false;
        }
        retainedSchemaBytes += added;
        schemas.push(asset);
        return true;
      };
      try {
        let stoppedEarly = false;
        for await (const entry of reader.entries(input.signal)) {
          throwIfJadxInterrupted(input.signal);
          examinedEntries += 1;
          if (examinedEntries > ANDROID_APP_FUNCTIONS_LIMITS.apkEntries) {
            status = "partial";
            stoppedEarly = true;
            diagnostics.pushParts([
              "APK archive entry scan reached the ",
              String(ANDROID_APP_FUNCTIONS_LIMITS.apkEntries),
              "-entry limit; remaining AppFunctions schema assets were not inspected.",
            ]);
            break;
          }
          const isReferenced = referenced.has(entry.path);
          const matchesPattern = APP_FUNCTION_ASSET_PATTERN.test(entry.path);
          if (!isReferenced && !matchesPattern) continue;
          if (entry.kind === "directory" && !isReferenced) continue;
          if (seenPaths.has(entry.path)) duplicatePaths.add(entry.path);
          else seenPaths.add(entry.path);
          if (schemas.length >= ANDROID_APP_FUNCTIONS_LIMITS.schemaAssets) {
            status = "partial";
            stoppedEarly = true;
            diagnostics.pushParts([
              "Bundled AppFunctions schema asset scan reached the ",
              String(ANDROID_APP_FUNCTIONS_LIMITS.schemaAssets),
              "-file limit.",
            ]);
            break;
          }
          const sourcePath = entry.sourcePath ?? entry.path;
          inProgress = {
            path: entry.path,
            source_path: sourcePath,
            sha256: null,
            size: null,
            status: "unavailable",
            functions: [],
            limitations: ["AppFunctions schema asset read did not complete."],
          };
          const overBudget =
            entry.declaredSize === null ||
            !Number.isSafeInteger(entry.declaredSize) ||
            entry.declaredSize < 0 ||
            entry.declaredSize >
              ANDROID_APP_FUNCTIONS_LIMITS.schemaAssetBytes ||
            entry.declaredSize >
              ANDROID_APP_FUNCTIONS_LIMITS.totalSchemaBytes - totalReadBytes;
          if (entry.kind !== "file" || entry.encrypted || overBudget) {
            status = "partial";
            const unavailableAsset: AndroidAppFunctionSchemaAsset = {
              path: entry.path,
              source_path: sourcePath,
              sha256: null,
              size: null,
              status: "unavailable",
              functions: [],
              limitations: [
                entry.encrypted
                  ? "AppFunctions schema asset is encrypted in the APK archive."
                  : entry.kind !== "file"
                    ? "AppFunctions schema path is not a regular file in the APK archive."
                    : `AppFunctions schema asset exceeds the ${String(ANDROID_APP_FUNCTIONS_LIMITS.schemaAssetBytes)}-byte per-asset or ${String(ANDROID_APP_FUNCTIONS_LIMITS.totalSchemaBytes)}-byte cumulative XML budget.`,
              ],
            };
            inProgress = undefined;
            if (!admitSchema(unavailableAsset)) {
              stoppedEarly = true;
              break;
            }
            continue;
          }
          const declaredSize = entry.declaredSize!;
          totalReadBytes += declaredSize;
          let assetObservation: AndroidAppFunctionSchemaAsset;
          try {
            const bytes = await readExactZipMemberBytes(
              reader,
              entry,
              declaredSize,
              input.signal,
            );
            throwIfJadxInterrupted(input.signal);
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            inProgress = {
              path: entry.path,
              source_path: sourcePath,
              sha256,
              size: bytes.length,
              status: "unavailable",
              functions: [],
              limitations: [
                "AppFunctions schema XML parsing did not complete.",
              ],
            };
            let xmlText: string | undefined;
            try {
              xmlText = utf8Decoder.decode(bytes);
            } catch {
              xmlText = undefined;
            }
            if (xmlText === undefined) {
              status = "partial";
              assetObservation = {
                path: entry.path,
                source_path: sourcePath,
                sha256,
                size: bytes.length,
                status: "unavailable",
                functions: [],
                limitations: [
                  "AppFunctions schema asset is not valid UTF-8 text.",
                ],
              };
            } else {
              const parsedXml = parseAndroidAppFunctionXml(xmlText, budgets);
              throwIfJadxInterrupted(input.signal);
              if (parsedXml.status !== "complete") status = "partial";
              assetObservation = {
                path: entry.path,
                source_path: sourcePath,
                sha256,
                size: bytes.length,
                status: parsedXml.status,
                functions: [...parsedXml.functions],
                limitations: [...parsedXml.limitations],
              };
            }
          } catch (cause: unknown) {
            if (cause instanceof JadxInterruption) throw cause;
            if (
              cause instanceof ArtifactReaderFailure &&
              cause.reason === "cancelled"
            )
              throw input.interruption(input.signal.reason);
            status = "partial";
            assetObservation = {
              path: entry.path,
              source_path: sourcePath,
              sha256: null,
              size: null,
              status: "unavailable",
              functions: [],
              limitations: [
                boundedDiagnosticToken(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              ],
            };
          }
          inProgress = undefined;
          if (!admitSchema(assetObservation)) {
            stoppedEarly = true;
            break;
          }
        }
        if (!stoppedEarly) exhaustedArchive = true;
        throwIfJadxInterrupted(input.signal);
      } catch (cause: unknown) {
        if (cause instanceof JadxInterruption) {
          failed = true;
          primary = input.interruption(cause.reason);
        } else if (
          cause instanceof ArtifactReaderFailure &&
          cause.reason === "cancelled"
        ) {
          failed = true;
          primary = input.interruption(input.signal.reason);
        } else if (cause instanceof AnalysisError) {
          failed = true;
          primary = cause;
        } else if (input.signal.aborted) {
          failed = true;
          primary = input.interruption(input.signal.reason);
        } else {
          archiveDegraded = true;
          inProgress = undefined;
          status = schemas.length > 0 ? "partial" : "unavailable";
          diagnostics.pushParts([
            "APK archive asset scan could not complete (",
            boundedDiagnosticToken(
              cause instanceof Error ? cause.message : String(cause),
            ),
            "); bundled AppFunctions XML schema assets may be unavailable.",
          ]);
        }
      }
      if (failed) {
        if (inProgress !== undefined) {
          // Retain carrier identity and authenticated digest/size if bytes finished before interruption.
          admitSchema(inProgress);
          inProgress = undefined;
        }
        status = schemas.length > 0 ? "partial" : "unavailable";
        diagnostics.pushParts([
          "AppFunctions schema asset scan did not exhaust APK inventory; remaining schema assets remain unknown.",
        ]);
      } else {
        if (duplicatePaths.size > 0) {
          status = "partial";
          for (const duplicate of [...duplicatePaths].sort(
            compareUnicodeCodePoints,
          ))
            diagnostics.pushParts([
              "APK archive contains multiple entries for ",
              boundedDiagnosticToken(duplicate),
              "; runtime asset resolution precedence is not established.",
            ]);
        }
        if (exhaustedArchive) {
          for (const referencedPath of input.referencedPaths) {
            if (!seenPaths.has(referencedPath)) {
              status = "partial";
              diagnostics.pushParts([
                "Manifest-referenced AppFunctions schema asset ",
                boundedDiagnosticToken(referencedPath),
                " was not found in the APK archive.",
              ]);
            }
          }
        }
      }
      const limitations = diagnostics.finish();
      const checkpoint: AndroidAppFunctionAssetCheckpoint = {
        scan_state:
          failed || archiveDegraded || !exhaustedArchive
            ? "interrupted"
            : "completed",
        status,
        examined_entries: examinedEntries,
        schemas: schemas.map((schema) => ({
          ...schema,
          functions: [...schema.functions],
          limitations: [...schema.limitations],
        })),
        limitations: [...limitations],
      };
      try {
        input.onObservation(checkpoint);
      } catch (observationError: unknown) {
        if (!failed) {
          primary = observationError;
          failed = true;
        }
      }
      const closeOutcome = await input.resources.release(owner);
      if (closeOutcome.kind === "failed") {
        const reason =
          closeOutcome.cause instanceof Error
            ? closeOutcome.cause.message
            : String(closeOutcome.cause);
        const cleanup = new ProviderCleanupError(
          "jadx",
          [owner.resource],
          { reason },
          { operation, cause: closeOutcome.cause },
        );
        if (!failed && input.signal.aborted) {
          failed = true;
          primary = input.interruption(input.signal.reason);
        }
        const failure = !failed
          ? cleanup
          : analysisErrorWithCleanupFailure(
              primary instanceof AnalysisError
                ? primary
                : analysisClientFailureForOperation(primary, "jadx", operation),
              cleanup,
              operation,
            );
        closeOutcome.lease.bindCleanupError(failure);
        throw failure;
      }
      if (failed) throw primary;
      throwIfJadxInterrupted(input.signal);
      return { status, examinedEntries, schemas, limitations };
    })
    .catch((cause: unknown) => {
      if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
        throw analysisClientFailureForOperation(
          cause,
          "jadx",
          "inspect_android_package",
        );
      throw cause;
    });

/** Combine manifest AppFunctionService bindings and bundled APK XML schema observations. */
export const projectAndroidAppFunctions = (
  manifestBindings: ReturnType<
    typeof extractAndroidAppFunctionManifestBindings
  >,
  assetScan: AndroidAppFunctionAssetScan | null,
): AndroidAppFunctionsInventory => {
  const services = [...manifestBindings.services];
  const schemas = assetScan === null ? [] : [...assetScan.schemas];
  const diagnostics = createBoundedDiagnostics(
    ANDROID_APP_FUNCTIONS_LIMITS.diagnosticBytes,
  );
  for (const message of manifestBindings.limitations)
    diagnostics.pushParts([message]);
  if (assetScan === null) {
    diagnostics.pushParts([
      "Bundled APK asset inspection was not performed; only manifest AppFunctionService declarations were inspected.",
    ]);
  } else {
    for (const message of assetScan.limitations)
      diagnostics.pushParts([message]);
  }
  const unavailableAssets = schemas.filter(
    (schema) => schema.status !== "complete",
  ).length;
  if (unavailableAssets > 0)
    diagnostics.pushParts([
      String(unavailableAssets),
      " bundled AppFunctions schema asset(s) had partial or unavailable XML coverage.",
    ]);
  const status: AndroidAppFunctionsInventory["status"] =
    manifestBindings.status === "unavailable" &&
    (assetScan === null || assetScan.status === "unavailable")
      ? "unavailable"
      : manifestBindings.status === "complete" &&
          assetScan !== null &&
          assetScan.status === "complete"
        ? "complete"
        : "partial";
  if (services.length > 0 || schemas.length > 0)
    diagnostics.pushParts([STATIC_SCOPE_LIMITATION]);
  return {
    status,
    services,
    schemas,
    limitations: diagnostics.finish(),
  };
};
