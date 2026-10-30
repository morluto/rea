import type { z } from "zod";
import type { AndroidRequest } from "../domain/android/androidAnalysis.js";
import { androidResultSchemas } from "../domain/android/androidAnalysis.js";
import { observedAndroidManifestComponentsSchema } from "../domain/android/androidManifestComponents.js";
import {
  type AndroidMappingQuery,
  type AndroidMappingSource,
  projectAndroidMapping,
} from "../domain/android/androidMapping.js";
import { parseAndroidManifestComponents } from "./AndroidManifestComponents.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { AndroidNativeDeclarations } from "../domain/android/androidNativeDeclarations.js";
import type { AndroidJniLibraries } from "./AndroidJniLibraries.js";
import {
  ANDROID_JNI_REPORT_BYTES,
  projectAndroidJniBindings,
} from "../domain/android/androidJniBindings.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  jadxAppSchema,
  type JadxClassPage,
  jadxClassSchema,
  jadxLoadSchema,
  jadxMethodSchema,
  jadxXrefsSchema,
  normalizeJadxText,
} from "./JadxProtocol.js";

/** The adapter consumes tool payloads, never provider RPC details outside this layer. */
export interface JadxToolPort {
  listClasses(input: {
    readonly query: string;
    readonly offset: number;
    readonly limit: number;
  }): Promise<JadxClassPage>;
  json(
    name: string,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue>;
  text(
    name: string,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<string>;
}

type Engine = z.infer<
  typeof androidResultSchemas.inspect_android_package
>["engine"];
type ClassSummary = z.infer<typeof jadxClassSchema>;
/** Session facts shared by every request, and the caller's optional mapping. */
export interface JadxAnalysisContext {
  readonly loaded: z.infer<typeof jadxLoadSchema> | undefined;
  readonly engine: Engine;
  readonly mapping?: AndroidMappingSource | undefined;
  readonly jni?: {
    readonly apkSha256: string;
    readonly inventory: () => Promise<AndroidNativeDeclarations>;
    readonly libraries: () => Promise<AndroidJniLibraries>;
  };
}

const observedPackageSchema =
  androidResultSchemas.inspect_android_package.extend({
    components: observedAndroidManifestComponentsSchema,
  });

const methodsOf = (summary: ClassSummary) => {
  const seen = new Map<string, number>();
  return summary.methods.map((method) => {
    const index = seen.get(method.name) ?? 0;
    seen.set(method.name, index + 1);
    return {
      name: method.name,
      reported_signature: method.signature,
      overload_index: index,
      is_constructor: method.is_constructor,
      dex_descriptor: method.dex_descriptor,
    };
  });
};

/** Mapping lookups use the bridge's raw DEX identities, never display aliases. */
const classQuery = (summary: ClassSummary): AndroidMappingQuery => ({
  kind: "class",
  name: summary.full_name,
  raw_name: summary.raw_name,
});

const innerClassQueries = (summary: ClassSummary): AndroidMappingQuery[] =>
  summary.inner_classes.map((name, index) => ({
    kind: "class",
    name,
    raw_name: summary.inner_class_raw_names[index] ?? "",
  }));

const methodQueries = (summary: ClassSummary) =>
  methodsOf(summary).map(
    (method, index): Extract<AndroidMappingQuery, { kind: "method" }> => ({
      kind: "method",
      class_raw_name: summary.raw_name,
      name: method.name,
      overload_index: method.overload_index,
      raw_name: summary.methods[index]?.raw_name ?? "",
      dex_descriptor: method.dex_descriptor,
    }),
  );

const fieldQueries = (summary: ClassSummary): AndroidMappingQuery[] =>
  summary.fields.map((field) => ({
    kind: "field",
    class_raw_name: summary.raw_name,
    name: field.name,
    raw_name: field.raw_name,
    dex_type: field.dex_type,
  }));

/** The optional mapping block; absent unless the caller selected a mapping. */
const mappingOf = (
  mapping: AndroidMappingSource | undefined,
  queries: () => AndroidMappingQuery[],
) =>
  mapping === undefined
    ? {}
    : { mapping: projectAndroidMapping(mapping, queries()) };

const inputFailure = (
  request: AndroidRequest,
  field: string,
  message: string,
): never => {
  throw new AnalysisInputError(request.operation, undefined, [
    { path: [field], reason: "invalid_value", message },
  ]);
};

const classSummary = async (
  tools: JadxToolPort,
  request: Exclude<
    AndroidRequest,
    {
      operation:
        | "inspect_android_package"
        | "search_android_classes"
        | "inspect_android_jni_bindings";
    }
  >,
): Promise<ClassSummary> => {
  // Only class inspection reports DEX static values; method and reference
  // lookups keep the member-only summary so large constants cannot block them.
  const raw = await tools.json("get_class_summary", {
    class_name: request.input.class_name,
    ...(request.operation === "inspect_android_class"
      ? { dex_static_values: true }
      : {}),
  });
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof raw.error === "string"
  )
    throw new AnalysisOutputError(
      request.operation,
      `JADX class summary failed: ${raw.error}`,
    );
  const summary = jadxClassSchema.safeParse(raw);
  if (!summary.success)
    throw new AnalysisOutputError(
      request.operation,
      "JADX class summary failed or was malformed; negative counts are not an empty class",
      { cause: summary.error },
    );
  const value = summary.data;
  if (
    value.full_name !== request.input.class_name &&
    value.raw_name !== request.input.class_name
  )
    inputFailure(
      request,
      "class_name",
      `Exact class ${request.input.class_name} resolved to ${value.full_name}; use the fully qualified class name from search_android_classes.`,
    );
  if (
    value.method_count !== value.methods.length ||
    value.field_count !== value.fields.length ||
    value.inner_class_count !== value.inner_classes.length ||
    value.inner_class_raw_names.length !== value.inner_classes.length
  )
    throw new AnalysisOutputError(
      request.operation,
      "JADX class member counts do not match the returned inventory",
    );
  return value;
};

const inspectPackage = async (
  tools: JadxToolPort,
  loaded: z.infer<typeof jadxLoadSchema>,
  engine: Engine,
): Promise<JsonValue> => {
  const app = jadxAppSchema.parse(await tools.json("get_app_info", {}));
  const manifest = normalizeJadxText(
    await tools.text("get_android_manifest", {}),
  );
  return observedPackageSchema.parse({
    engine,
    package_name: app.package || null,
    version_name: app.version_name || null,
    version_code: app.version_code || null,
    min_sdk: app.min_sdk || null,
    target_sdk: app.target_sdk || null,
    permissions: app.permissions,
    manifest,
    components: parseAndroidManifestComponents(
      manifest.text,
      manifest.status,
      app.target_sdk || null,
      app.min_sdk || null,
    ),
    class_count: loaded.class_count,
    resource_count: loaded.resource_count,
    signature_verification: "not_performed",
  });
};

const searchClasses = async (
  tools: JadxToolPort,
  request: Extract<AndroidRequest, { operation: "search_android_classes" }>,
  loaded: z.infer<typeof jadxLoadSchema>,
  engine: Engine,
): Promise<JsonValue> => {
  const matches: string[] = [];
  const pageSize = 4096;
  let offset = 0;
  do {
    const page = await tools.listClasses({
      query: request.input.query,
      offset,
      limit: pageSize,
    });
    if (
      page.total_classes !== loaded.class_count ||
      page.offset !== offset ||
      page.limit !== pageSize ||
      page.next_offset < offset ||
      page.next_offset > loaded.class_count ||
      page.items.length > pageSize ||
      page.items.length > page.next_offset - offset ||
      (request.input.query === "" &&
        page.items.length !== page.next_offset - offset) ||
      page.items.some((name) => !name.includes(request.input.query))
    )
      throw new AnalysisOutputError(
        request.operation,
        "JADX class pagination changed identity or counts",
      );
    if (
      (offset < loaded.class_count && page.next_offset === offset) ||
      (page.next_offset < loaded.class_count && page.items.length !== pageSize)
    )
      throw new AnalysisOutputError(
        request.operation,
        "JADX class pagination is incomplete",
      );
    matches.push(...page.items);
    offset = page.next_offset;
  } while (offset < loaded.class_count);
  const occurrences = new Map<string, number>();
  for (const name of matches)
    occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
  const duplicateNames = [...occurrences]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, occurrences: count }));
  return androidResultSchemas.search_android_classes.parse({
    engine,
    query: request.input.query,
    total_classes: loaded.class_count,
    matches,
    duplicate_names: duplicateNames,
    coverage: "complete",
  });
};

const matchingMethods = (
  summary: ClassSummary,
  request: Extract<
    AndroidRequest,
    { operation: "inspect_android_method" | "trace_android_references" }
  >,
) => {
  const candidates = methodsOf(summary).filter(
    (method) => method.name === request.input.method_name,
  );
  if (request.input.method_name !== undefined && candidates.length === 0)
    inputFailure(
      request,
      "method_name",
      `Method ${summary.full_name}.${request.input.method_name} was not found; inspect_android_class lists available methods.`,
    );
  return candidates;
};

const inspectMethod = async (
  tools: JadxToolPort,
  request: Extract<AndroidRequest, { operation: "inspect_android_method" }>,
  summary: ClassSummary,
  { engine, mapping }: JadxAnalysisContext,
): Promise<JsonValue> => {
  const candidates = matchingMethods(summary, request);
  if (candidates.length > 1 && request.input.overload_index === undefined)
    inputFailure(
      request,
      "overload_index",
      `Select one of ${candidates.length} overloads: ${candidates.map((method) => `${method.overload_index}: ${method.reported_signature}`).join("; ")}`,
    );
  const index = request.input.overload_index ?? 0;
  const selected =
    candidates[index] ??
    inputFailure(
      request,
      "overload_index",
      `Index ${index} is outside the ${candidates.length} matching overloads.`,
    );
  const body = jadxMethodSchema.parse(
    await tools.json("get_method_body", {
      class_name: request.input.class_name,
      method_name: request.input.method_name,
      overload_index: index,
      smali_fallback: true,
    }),
  );
  if (
    body.class_name !== summary.full_name ||
    body.method_name !== request.input.method_name ||
    body.overload_index !== index ||
    body.overload_count !== candidates.length ||
    body.dex_descriptor !== selected.dex_descriptor
  )
    throw new AnalysisOutputError(
      request.operation,
      "JADX returned a different method or overload inventory",
    );
  return androidResultSchemas.inspect_android_method.parse({
    engine,
    class_name: summary.full_name,
    method: selected,
    overload_count: candidates.length,
    representation: body.mode,
    body_status: body.body.length === 0 ? "not_available" : "available",
    fell_back: body.fell_back,
    markers: body.markers,
    source: normalizeJadxText(body.body),
    ...mappingOf(mapping, () => [
      classQuery(summary),
      ...methodQueries(summary).filter(
        (method) =>
          method.name === selected.name &&
          method.overload_index === selected.overload_index,
      ),
    ]),
  });
};

/** Normalize only the selected analyst outcome and reject ambiguous engine selectors. */
export const analyzeJadxRequest = async (
  tools: JadxToolPort,
  request: AndroidRequest,
  context: JadxAnalysisContext,
): Promise<JsonValue> => {
  const { loaded, engine } = context;
  if (request.operation === "inspect_android_jni_bindings") {
    if (context.jni === undefined)
      throw new AnalysisOutputError(
        request.operation,
        "Native declaration and immutable APK library readers are unavailable.",
      );
    const inventory = await context.jni.inventory();
    const libraries = await context.jni.libraries();
    const { path, ...selection } = request.input;
    const projected = projectAndroidJniBindings({
      apk: { path, sha256: context.jni.apkSha256 },
      selection,
      inventory,
      libraries: libraries.libraries,
      libraryInventory: libraries.inventory,
    });
    if (!projected.ok)
      throw new AnalysisResourceConstraintError(
        request.operation,
        "memory",
        "JNI relationship facts exceed the bounded retained report allowance.",
        { limit_bytes: ANDROID_JNI_REPORT_BYTES },
        {
          retryable: false,
          remediationAction:
            "Select fewer ABI or library occurrences; raw declaration uniqueness remains global.",
        },
      );
    return androidResultSchemas.inspect_android_jni_bindings.parse({
      ...projected.value,
      engine,
    });
  }
  if (loaded === undefined)
    throw new AnalysisOutputError(
      request.operation,
      "Decompiler operation requires the admitted APK to be loaded.",
    );
  if (request.operation === "inspect_android_package")
    return inspectPackage(tools, loaded, engine);
  if (request.operation === "search_android_classes")
    return searchClasses(tools, request, loaded, engine);
  const summary = await classSummary(tools, request);
  if (request.operation === "inspect_android_class")
    return androidResultSchemas.inspect_android_class.parse({
      engine,
      class_name: summary.full_name,
      methods: methodsOf(summary),
      fields: summary.fields.map((field) => ({
        name: field.name,
        reported_type: field.type,
        dex_static_value: field.dex_static_value ?? null,
      })),
      inner_classes: summary.inner_classes,
      ...mappingOf(context.mapping, () => [
        classQuery(summary),
        ...innerClassQueries(summary),
        ...methodQueries(summary),
        ...fieldQueries(summary),
      ]),
    });
  if (request.operation === "inspect_android_method")
    return inspectMethod(tools, request, summary, context);
  return traceReferences(tools, request, summary, engine);
};

const traceReferences = async (
  tools: JadxToolPort,
  request: Extract<AndroidRequest, { operation: "trace_android_references" }>,
  summary: ClassSummary,
  engine: Engine,
): Promise<JsonValue> => {
  const methodName = request.input.method_name;
  const candidates = matchingMethods(summary, request);
  if (methodName === undefined && request.input.overload_index !== undefined)
    inputFailure(
      request,
      "overload_index",
      "Method name is required for an overload index.",
    );
  if (candidates.length > 1 && request.input.overload_index === undefined)
    inputFailure(
      request,
      "overload_index",
      `Select one of ${candidates.length} overloads: ${candidates.map((method) => `${method.overload_index}: ${method.reported_signature}`).join("; ")}`,
    );
  const index = request.input.overload_index ?? 0;
  const selected = methodName === undefined ? undefined : candidates[index];
  if (methodName !== undefined && selected === undefined)
    inputFailure(
      request,
      "overload_index",
      `Index ${index} is outside the ${candidates.length} matching overloads.`,
    );
  const expectedTarget =
    methodName === undefined
      ? summary.full_name
      : `${summary.full_name}.${methodName}`;
  const xrefs = jadxXrefsSchema.parse(
    await tools.json(
      methodName === undefined ? "get_xrefs_to_class" : "get_xrefs_to_method",
      {
        class_name: request.input.class_name,
        ...(methodName === undefined
          ? {}
          : { method_name: methodName, overload_index: index }),
        limit: 2_147_483_647,
        resolve_line: false,
      },
    ),
  );
  if (
    xrefs.target !== expectedTarget ||
    (selected !== undefined &&
      (xrefs.overload_index !== index ||
        xrefs.reported_signature !== selected.reported_signature)) ||
    xrefs.total !== xrefs.count ||
    xrefs.count !== xrefs.items.length
  )
    throw new AnalysisOutputError(
      request.operation,
      "JADX references are incomplete or refer to another target",
    );
  return androidResultSchemas.trace_android_references.parse({
    engine,
    class_name: summary.full_name,
    method_name: methodName ?? null,
    overload_index: selected?.overload_index ?? null,
    reported_signature: selected?.reported_signature ?? null,
    dex_descriptor: selected?.dex_descriptor ?? null,
    total: xrefs.total,
    references: xrefs.items.map((reference) => ({
      kind: reference.kind,
      name: reference.name,
      reported_full_name: reference.full_name,
      containing_class: reference.containing_class,
      top_class: reference.top_class,
      source_line: null,
      dex_offset: null,
      direct_invokes: reference.direct_invokes ?? null,
      direct_invokes_exhaustive: reference.direct_invokes_exhaustive ?? null,
    })),
    coverage: "complete",
    reference_unit: "using_node",
  });
};
