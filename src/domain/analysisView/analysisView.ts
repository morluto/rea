import { z } from "zod";
import { javaScriptSourceSelectionSchema } from "../javascript/javascriptSourceSelection.js";

import {
  AnalysisInputError,
  type AnalysisInputIssue,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { evidenceSchema, type Evidence } from "../evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { binaryLayoutSchema } from "../native/binaryLayout.js";
import { functionDossierSchema } from "../hopperValues.js";
import {
  artifactGraphManifestSchema,
  artifactNodeSchema,
  artifactOccurrenceSchema,
  artifactEdgeSchema,
  integrityContradictionSchema,
} from "../artifactGraph.js";
import { artifactInspectionResultSchema } from "../artifactInspection.js";
import {
  parseOwnedJavaScriptApplicationAnalysisSteps,
  type JavaScriptApplicationAnalysisResult,
} from "../javascript/javascriptApplicationAnalysis.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { projectBinaryLayoutView } from "./binaryLayoutView.js";
import { projectJavaScriptApplicationView } from "./javascriptApplicationView.js";
import {
  projectWebNetworkApiSurfaceView,
  apiSurfaceFields,
  apiSurfaceViewSchema,
} from "./webNetworkApiSurfaceView.js";
import { projectNativeFunctionView } from "./nativeFunctionView.js";
import {
  projectEvmInterfaceView,
  evmViewRequestSchema,
  evmViewItemSchema,
  evmSummarySchema,
} from "./evmInterfaceView.js";
import { projectArtifactInventoryView } from "./artifactInventoryView.js";
import {
  projectManagedArtifactView,
  managedViewRequestSchema,
  managedViewItemSchema,
  managedSummarySchema,
  managedViewContextSchema,
} from "./managedArtifactView.js";
import {
  projectWasmArtifactView,
  wasmViewRequestSchema,
  wasmViewItemSchema,
  wasmSummarySchema,
} from "./wasmArtifactView.js";
import {
  machoSummarySchema,
  machoViewContextSchema,
  machoViewItemSchema,
  machoViewRequestSchema,
  projectMachoView,
} from "./machoView.js";
import {
  projectWebNetworkCaptureView,
  captureViewRequestSchema,
  captureViewItemsSchema,
  captureSummarySchema,
} from "./webNetworkCaptureView.js";
import type { WebNetworkApiSurfaceAccumulator } from "./WebNetworkApiSurfaceAccumulator.js";
import {
  pcapViewRequestSchema,
  pcapViewPageSchema,
  pcapSummarySchema,
  projectPcapCaptureView,
} from "./pcapCaptureView.js";
import {
  qlogViewRequestSchema,
  qlogViewPageSchema,
  qlogViewContextSchema,
} from "./qlogCaptureView.js";
import {
  projectAndroidPackageView,
  androidPackageSummarySchema,
  androidViewRequestSchema,
  androidManifestViewItemSchema,
} from "./androidPackageView.js";
import {
  projectDartAotView,
  dartAotSummarySchema,
  dartAotViewRequestSchema,
  dartAotViewContextSchema,
} from "./dartAotView.js";

/** Public name of the selected-view workflow. */
export const INSPECT_ANALYSIS_VIEW_OPERATION = "inspect_analysis_view" as const;

const summaryViewSchema = z.strictObject({ kind: z.literal("summary") });
const facetViewSchema = z.strictObject({
  kind: z.literal("facet"),
  facet: z.enum(["mitigations", "linkage"]),
});
const indexSelectorSchema = z.strictObject({
  index: z.number().int().nonnegative(),
});
const nameSelectorSchema = z.strictObject({ name: z.string() });
const pathSelectorSchema = z.strictObject({
  path: z
    .string()
    .describe(
      "Exact observed module path or original source-map reference from a module page; an empty reference is valid.",
    ),
});
const nodeIdSelectorSchema = z.strictObject({
  node_id: prefixedDigestSchema("jag_node"),
});
const moduleItemViewSchema = z.strictObject({
  kind: z.literal("item"),
  collection: z.literal("modules"),
  selector: z.union([pathSelectorSchema, nodeIdSelectorSchema]),
});
const sectionOrSymbolItemViewSchema = z.strictObject({
  kind: z.literal("item"),
  collection: z.enum(["sections", "symbols"]),
  selector: z.union([indexSelectorSchema, nameSelectorSchema]),
});
/**
 * The collection-specific selector alternatives are expressed in the owning
 * contract so the advertised JSON Schema preserves them: modules accept
 * path/node_id, sections and symbols accept index/name. Refinement-only
 * constraints do not survive JSON Schema conversion, so the advertised
 * schema previously accepted combinations that runtime input validation
 * rejects.
 */
const itemViewSchema = z.discriminatedUnion("collection", [
  moduleItemViewSchema,
  sectionOrSymbolItemViewSchema,
]);
const pageViewSchema = z.strictObject({
  kind: z.literal("page"),
  collection: z.enum(["sections", "symbols", "modules"]),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

/** Bounded native function facets of already authenticated analyze_function Evidence. */
const nativeViewSchema = z.strictObject({
  kind: z.literal("native"),
  facet: z.enum([
    "procedure",
    "pseudocode",
    "assembly",
    "basic_blocks",
    "comments",
    "callers",
    "callees",
    "incoming_references",
    "outgoing_references",
    "unresolved_calls",
    "referenced_strings",
    "referenced_names",
    "native_api",
    "value_flow_summary",
    "value_flow_operations",
    "value_flow_def_use",
    "value_flow_effects",
    "value_flow_parameters",
    "value_flow_parameter_uses",
  ]),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

/** Original inventory records in stable order, optionally matching exact paths. */
const inventoryViewSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    kind: z.literal("inventory"),
    collection: z.literal("occurrences"),
    logical_paths: z
      .array(z.string())
      .optional()
      .describe(
        "Exact recorded logical paths. Omitted selects all available occurrences; an empty array selects none. This does not resolve filesystem paths.",
      ),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().default(64),
  }),
  z.strictObject({
    kind: z.literal("inventory"),
    collection: z.enum(["nodes", "edges", "integrity_contradictions"]),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().default(64),
  }),
]);

/** Caller-selected projection of already completed analysis Evidence. */
export const analysisViewRequestSchema = z.discriminatedUnion("kind", [
  summaryViewSchema,
  facetViewSchema,
  itemViewSchema,
  pageViewSchema,
  nativeViewSchema,
  inventoryViewSchema,
  wasmViewRequestSchema,
  machoViewRequestSchema,
  evmViewRequestSchema,
  managedViewRequestSchema,
  androidViewRequestSchema,
  apiSurfaceViewSchema,
  captureViewRequestSchema,
  qlogViewRequestSchema,
  pcapViewRequestSchema,
  dartAotViewRequestSchema,
]);

// The application owns admission and authenticated Evidence parsing. SDK and
// CLI envelope parsing must borrow this unknown value rather than clone it
// before admission. Advertise the owning Evidence contract in both dialects.
const inlineEvidenceInputSchema = z.unknown().nonoptional();
inlineEvidenceInputSchema._zod.processJSONSchema =
  evidenceSchema._zod.processJSONSchema;

/** Unauthenticated inline input or an exact same-session retained reference. */
export const analysisViewSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("retained-evidence"),
    evidence_id: prefixedDigestSchema("ev"),
  }),
  z.strictObject({
    kind: z.literal("inline"),
    evidence: inlineEvidenceInputSchema,
  }),
]);

/** Public inspect_analysis_view input. */
export const inspectAnalysisViewInputSchema = z.strictObject({
  source: analysisViewSourceSchema,
  view: analysisViewRequestSchema,
});

const coverageSchema = z.strictObject({
  status: z.enum(["complete-within-view", "page", "empty"]),
  examined: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
  exhausted: z.boolean(),
});

const artifactSchema = z.strictObject({
  path: z
    .string()
    .describe("Exact recorded artifact path, including an empty string."),
  sha256: digestSchema.nullable(),
});

const layoutSummarySchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  format: z.literal("elf"),
  architecture: z.strictObject({
    machine: z.literal("EM_X86_64"),
    bits: z.literal(64),
    byte_order: z.literal("little"),
  }),
  image_type: z.enum(["ET_EXEC", "ET_DYN", "ET_REL"]),
  entry: z.strictObject({
    reported_value: z.string().min(1),
    meaning: z.enum(["linked-virtual-address", "not-applicable", "absent"]),
    execution_status: z.literal("unknown"),
  }),
  counts: z.strictObject({
    sections: z.number().int().nonnegative(),
    segments: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    relocations: z.number().int().nonnegative(),
  }),
  limitation_count: z.number().int().nonnegative(),
});

const javascriptSummarySchema = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["asar", "directory"]),
  root_artifact_sha256: digestSchema,
  source_selection: javaScriptSourceSelectionSchema.exactOptional(),
  statistics: jsonObjectSchema,
  electron: jsonObjectSchema,
  coverage: jsonObjectSchema,
  limitation_count: z.number().int().nonnegative(),
});

const inventorySummarySchema = z.strictObject({
  manifest: artifactGraphManifestSchema,
  available_counts: z.strictObject({
    nodes: z.number().int().nonnegative(),
    occurrences: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    integrity_contradictions: z.number().int().nonnegative(),
  }),
  observed_entry_kind_counts: z.strictObject({
    file: z.number().int().nonnegative(),
    directory: z.number().int().nonnegative(),
    symlink: z.number().int().nonnegative(),
    slice: z.number().int().nonnegative(),
  }),
  source_complete: z.boolean(),
  inventory_evidence_ids: z.array(prefixedDigestSchema("ev")).min(1),
  inspection: z
    .strictObject({
      coverage: artifactInspectionResultSchema.shape.coverage,
      unexplored_branches:
        artifactInspectionResultSchema.shape.unexplored_branches,
    })
    .nullable(),
  limitation_count: z.number().int().nonnegative(),
});

const viewResultBase = {
  parent_evidence_id: prefixedDigestSchema("ev"),
  parent_operation: z.enum([
    "inspect_binary_layout",
    "analyze_javascript_application",
    "analyze_function",
    "inspect_artifact",
    "inventory_artifact",
    "inspect_wasm_artifact",
    "inspect_macho",
    "inspect_evm_interface",
    "inspect_managed_artifact",
    "inspect_web_network_capture",
    "inspect_android_package",
    "inspect_pcap_capture",
    "inspect_dart_aot",
  ]),
  parent_digest: digestSchema,
  view_digest: digestSchema,
  artifact: artifactSchema,
  coverage: coverageSchema,
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
} as const;

const summaryViewResultBase = {
  kind: z.literal("summary"),
  view: summaryViewSchema,
  ...viewResultBase,
} as const;

/** Summary `inspect_binary_layout` detail returns; no other view kind. */
export const binaryLayoutSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  summary: layoutSummarySchema,
  parent_operation: z.literal("inspect_binary_layout"),
});

/** Summary `analyze_javascript_application` detail returns; no other view kind. */
export const javascriptApplicationSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  summary: javascriptSummarySchema,
  parent_operation: z.literal("analyze_javascript_application"),
});

/** Exact summary carrier for artifact inspection's optional delivery contract. */
export const artifactInventorySummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.enum(["inspect_artifact", "inventory_artifact"]),
  summary: inventorySummarySchema,
});

/** Exact summary carrier for WASM inspection's optional delivery contract. */
export const wasmArtifactSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_wasm_artifact"),
  summary: wasmSummarySchema,
});

/** Exact slice identity and collection counts for Mach-O's selected delivery. */
export const machoSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_macho"),
  summary: machoSummarySchema,
});

/** Exact inferred-interface summary for EVM's caller-selected delivery. */
export const evmInterfaceSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_evm_interface"),
  summary: evmSummarySchema,
});

/** Exact metadata overview for the managed artifact's selected delivery. */
export const managedArtifactSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_managed_artifact"),
  summary: managedSummarySchema,
});

/** Exact historical capture summary, with no body or member-inventory payload. */
export const webNetworkCaptureSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_web_network_capture"),
  summary: captureSummarySchema,
});

/** Exact package declarations with retained decoded manifest text. */
export const androidPackageSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_android_package"),
  summary: androidPackageSummarySchema,
});

export const pcapCaptureSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_pcap_capture"),
  summary: pcapSummarySchema,
});

/** Exact snapshot and pool-coverage carrier for selected AOT delivery. */
export const dartAotSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_dart_aot"),
  summary: dartAotSummarySchema,
});

/** Projected facts for one selected view of retained analysis Evidence. */
export const analysisViewResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...viewResultBase,
    ...apiSurfaceFields,
    kind: z.literal("api-surface"),
    parent_operation: z.literal("inspect_web_network_capture"),
    view: apiSurfaceViewSchema,
    artifact: z.strictObject({
      path: z.string(),
      sha256: digestSchema.nullable(),
    }),
  }),
  z.strictObject({
    ...summaryViewResultBase,
    summary: z.union([
      layoutSummarySchema,
      javascriptSummarySchema,
      inventorySummarySchema,
      wasmSummarySchema,
      machoSummarySchema,
      evmSummarySchema,
      managedSummarySchema,
      captureSummarySchema,
      androidPackageSummarySchema,
      pcapSummarySchema,
      dartAotSummarySchema,
    ]),
  }),
  z.strictObject({
    kind: z.literal("capture"),
    view: captureViewRequestSchema,
    items: captureViewItemsSchema,
    ...viewResultBase,
    parent_operation: z.literal("inspect_web_network_capture"),
  }),
  z.strictObject({
    kind: z.literal("qlog"),
    view: qlogViewRequestSchema,
    page: qlogViewPageSchema,
    context: qlogViewContextSchema,
    ...viewResultBase,
    parent_operation: z.literal("inspect_web_network_capture"),
  }),
  z.strictObject({
    kind: z.literal("pcap"),
    view: pcapViewRequestSchema,
    page: pcapViewPageSchema,
    source_coverage: z.enum(["complete", "partial"]),
    ...viewResultBase,
    parent_operation: z.literal("inspect_pcap_capture"),
  }),
  z.strictObject({
    kind: z.literal("facet"),
    view: facetViewSchema,
    facet: jsonValueSchema,
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("item"),
    view: itemViewSchema,
    item: jsonValueSchema,
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("page"),
    view: pageViewSchema,
    items: z.array(jsonValueSchema),
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("native"),
    view: nativeViewSchema,
    procedure_address: z.string().nullable(),
    item: jsonValueSchema,
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("wasm"),
    view: wasmViewRequestSchema,
    item: wasmViewItemSchema,
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("macho"),
    view: machoViewRequestSchema,
    item: machoViewItemSchema,
    ...viewResultBase,
    ...machoViewContextSchema.shape,
    parent_operation: z.literal("inspect_macho"),
  }),
  z.strictObject({
    kind: z.literal("evm"),
    view: evmViewRequestSchema,
    item: evmViewItemSchema,
    ...viewResultBase,
    parent_operation: z.literal("inspect_evm_interface"),
  }),
  z.strictObject({
    kind: z.literal("managed"),
    view: managedViewRequestSchema,
    item: managedViewItemSchema,
    ...viewResultBase,
    ...managedViewContextSchema.shape,
    parent_operation: z.literal("inspect_managed_artifact"),
  }),
  z.strictObject({
    kind: z.literal("android"),
    view: androidViewRequestSchema,
    item: androidManifestViewItemSchema,
    ...viewResultBase,
    parent_operation: z.literal("inspect_android_package"),
  }),
  z.strictObject({
    kind: z.literal("dart-aot"),
    view: dartAotViewRequestSchema,
    items: z.array(z.string()),
    ...viewResultBase,
    ...dartAotViewContextSchema.shape,
    parent_operation: z.literal("inspect_dart_aot"),
  }),
  z.strictObject({
    kind: z.literal("inventory"),
    view: inventoryViewSchema,
    manifest: artifactGraphManifestSchema,
    inventory_evidence_ids: z.array(prefixedDigestSchema("ev")).min(1),
    source_complete: z.boolean(),
    items: z.array(
      z.union([
        artifactNodeSchema,
        artifactOccurrenceSchema,
        artifactEdgeSchema,
        integrityContradictionSchema,
      ]),
    ),
    ...viewResultBase,
  }),
]);

export type AnalysisViewRequest = z.output<typeof analysisViewRequestSchema>;
export type InspectAnalysisViewInput = z.output<
  typeof inspectAnalysisViewInputSchema
>;
export type AnalysisViewResult = z.output<typeof analysisViewResultSchema>;
export type AnalysisViewCoverage = z.output<typeof coverageSchema>;

/** Parent record already resolved from inline Evidence or a session reference. */
export interface AnalysisViewParent {
  readonly evidenceId: string;
  readonly operation: string;
  readonly normalizedResult: unknown;
  /** Preserve the authenticated source identity, including explicit absence. */
  readonly subject?: Evidence["subject"];
  readonly limitations: readonly string[];
  readonly artifact?: { readonly path: string; readonly sha256: string } | null;
  /** Parent Evidence parameters, when the parent operation records them. */
  readonly parameters?: unknown;
}

/** Construct a typed input failure for one selected-view constraint. */
export const analysisViewInputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError =>
  new AnalysisInputError(INSPECT_ANALYSIS_VIEW_OPERATION, undefined, issues);

/** View payload before the content digest is attached. */
export type UnsignedAnalysisView =
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "api-surface" }>,
      "view_digest"
    >
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "summary" }>,
      "view_digest"
    >
  | Omit<Extract<AnalysisViewResult, { readonly kind: "facet" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "item" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "page" }>, "view_digest">
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "native" }>,
      "view_digest"
    >
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "inventory" }>,
      "view_digest"
    >
  | Omit<Extract<AnalysisViewResult, { readonly kind: "wasm" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "macho" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "evm" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "qlog" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "pcap" }>, "view_digest">
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "capture" }>,
      "view_digest"
    >
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "managed" }>,
      "view_digest"
    >
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "android" }>,
      "view_digest"
    >
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "dart-aot" }>,
      "view_digest"
    >;

/** Attach the content digest that must change when projected bytes change. */
export const sealAnalysisView = (
  projection: UnsignedAnalysisView,
): AnalysisViewResult =>
  analysisViewResultSchema.parse({
    ...projection,
    view_digest: digestCanonicalValue(projection, "Analysis view"),
  });

const parentDigest = (evidenceId: string): string => evidenceId.slice(3);

const parseJavaScriptParent = (
  input: unknown,
): Result<JavaScriptApplicationAnalysisResult, AnalysisError> => {
  try {
    // Only the existing realm-private graph proofs permit reuse. Imported or
    // merely frozen graphs still receive full canonical validation.
    const steps = parseOwnedJavaScriptApplicationAnalysisSteps(input);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return ok(step.value);
  } catch (cause: unknown) {
    if (!(cause instanceof z.ZodError)) throw cause;
    return err(
      analysisInputErrorFromIssues(
        INSPECT_ANALYSIS_VIEW_OPERATION,
        cause.issues.map((issue) => ({
          ...issue,
          path: ["source", "normalized_result", ...issue.path],
        })),
        { source: { normalized_result: input } },
        { cause },
      ),
    );
  }
};

const unsupportedParent = (
  parent: AnalysisViewParent,
): AnalysisUnsupportedTargetError =>
  new AnalysisUnsupportedTargetError(
    INSPECT_ANALYSIS_VIEW_OPERATION,
    parentArtifactPath(parent),
    `Parent Evidence operation ${JSON.stringify(parent.operation)} does not support analysis views. Use completed binary layout, JavaScript application, native function, artifact inventory/inspection, WASM, Mach-O, EVM, managed artifact, Android package, Dart AOT, or web network capture Evidence.`,
  );

const parentArtifactPath = (parent: AnalysisViewParent): string => {
  if (
    typeof parent.normalizedResult === "object" &&
    parent.normalizedResult !== null &&
    "artifact" in parent.normalizedResult &&
    typeof parent.normalizedResult.artifact === "object" &&
    parent.normalizedResult.artifact !== null &&
    "path" in parent.normalizedResult.artifact &&
    typeof parent.normalizedResult.artifact.path === "string"
  )
    return parent.normalizedResult.artifact.path;
  if (
    typeof parent.normalizedResult === "object" &&
    parent.normalizedResult !== null &&
    "input_path" in parent.normalizedResult &&
    typeof parent.normalizedResult.input_path === "string"
  )
    return parent.normalizedResult.input_path;
  return parent.evidenceId;
};

/** Named source owners for views that need no extra decoder or accumulator. */
const retainedViewProjectors = new Map<string, typeof projectWasmArtifactView>([
  ["inspect_wasm_artifact", projectWasmArtifactView],
  ["inspect_macho", projectMachoView],
  ["inspect_evm_interface", projectEvmInterfaceView],
  ["inspect_managed_artifact", projectManagedArtifactView],
  ["inspect_android_package", projectAndroidPackageView],
  ["inspect_dart_aot", projectDartAotView],
  ["inspect_artifact", projectArtifactInventoryView],
  ["inventory_artifact", projectArtifactInventoryView],
]);

/** Project one selected view from authenticated parent analysis Evidence. */
export const projectAnalysisView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
  apiSurfaceAccumulator?: WebNetworkApiSurfaceAccumulator,
): Result<AnalysisViewResult, AnalysisError> => {
  const digest = parentDigest(parent.evidenceId);
  if (!digestSchema.safeParse(digest).success)
    return err(
      analysisViewInputError([
        {
          path: ["source"],
          reason: "invalid_format",
          message: "Parent Evidence ID is not a digest-backed identifier.",
        },
      ]),
    );
  if (view.kind === "api-surface") {
    const projected = projectWebNetworkApiSurfaceView(
      parent,
      view,
      apiSurfaceAccumulator,
    );
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  if (parent.operation === "inspect_web_network_capture") {
    const projected = projectWebNetworkCaptureView(parent, view);
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  if (parent.operation === "inspect_pcap_capture") {
    const projected = projectPcapCaptureView(parent, view);
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  if (parent.operation === "inspect_binary_layout") {
    const layout = binaryLayoutSchema.safeParse(parent.normalizedResult);
    if (!layout.success)
      return err(
        analysisViewInputError([
          {
            path: ["source"],
            reason: "invalid_value",
            message:
              "Parent Evidence result does not match inspect_binary_layout.",
          },
        ]),
      );
    const projected = projectBinaryLayoutView(parent, layout.data, view);
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  if (parent.operation === "analyze_javascript_application") {
    const analysis = parseJavaScriptParent(parent.normalizedResult);
    if (!analysis.ok) return analysis;
    const projected = projectJavaScriptApplicationView(
      parent,
      analysis.value,
      view,
    );
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  if (parent.operation === "analyze_function") {
    const native = functionDossierSchema.safeParse(parent.normalizedResult);
    if (!native.success)
      return err(
        analysisInputErrorFromIssues(
          INSPECT_ANALYSIS_VIEW_OPERATION,
          native.error.issues.map((issue) => ({
            ...issue,
            path: ["source", "normalized_result", ...issue.path],
          })),
          { source: { normalized_result: parent.normalizedResult } },
          { cause: native.error },
        ),
      );
    const projected = projectNativeFunctionView(parent, native.data, view);
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  const project = retainedViewProjectors.get(parent.operation);
  if (project !== undefined) {
    const projected = project(parent, view);
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  return err(unsupportedParent(parent));
};
