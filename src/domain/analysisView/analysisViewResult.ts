import {
  NATIVE_INVENTORY_OPERATIONS,
  nativeInventoryOperationSchema,
} from "../native/nativeInventory.js";
import {
  NATIVE_OBSERVATION_OPERATIONS,
  type NativeObservationOperation,
} from "../native/nativeObservation.js";
import { z } from "zod";
import { knownCoverageStatusSchema } from "../coverage.js";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { jsonObjectSchema, jsonValueSchema } from "../jsonValue.js";
import { bundleResourceRootSchema } from "../apple/bundleResourceRoot.js";
import {
  artifactGraphManifestSchema,
  artifactInventoryCoverageSchema,
} from "../artifactGraph.js";
import { desktopCoverageSchema } from "../desktopApplication.js";
import { nativeFunctionMatchingContextSchema } from "../native/functionMatching.js";
import {
  rustBinaryViewPageSchema,
  rustBinaryViewRequestSchema,
} from "../rust/rustBinaryQuery.js";
import {
  analysisViewCoverageSchema,
  nullableCollectionViewCoverageSchema,
} from "./analysisViewCoverage.js";
import {
  artifactSchema,
  summaryViewResultBase,
  viewResultBaseFields,
} from "./analysisViewBase.js";
import { recordedArrayViewSchema } from "./analysisViewRequest.js";
import {
  facetViewSchema,
  itemViewSchema,
  nativeViewSchema,
  pageViewSchema,
} from "./analysisViewShape.js";
import { apiSurfaceFields, apiSurfaceViewSchema } from "./apiSurfaceSchema.js";
import {
  artifactInventoryItemsSchema,
  artifactInventoryViewRequestSchema,
} from "./artifactInventoryView.js";
import {
  batchDecompileSummarySchema,
  batchDecompileViewCollections,
  batchDecompileViewContextSchema,
} from "./batchDecompileView.js";
import {
  browserScenarioViewContextSchema,
  browserScenarioViewItemsSchema,
  browserScenarioViewRequestSchema,
} from "./browserScenarioViewSchemas.js";
import {
  cycloneDxDocumentSchema,
  cycloneDxSourceCoverageSchema,
  cycloneDxViewRequestSchema,
} from "./cyclonedxView.js";
import {
  dartAotViewContextSchema,
  dartAotViewRequestSchema,
} from "./dartAotView.js";
import {
  desktopViewItemsSchema,
  desktopViewRequestSchema,
} from "./desktopApplicationView.js";
import {
  devicetreePageContextSchema,
  devicetreeViewItemsSchema,
  devicetreeViewRequestSchema,
} from "./devicetreeView.js";
import {
  elfDependenciesSummarySchema,
  elfDependenciesViewItemsSchema,
  elfDependenciesViewRequestSchema,
} from "./elfDependenciesView.js";
import {
  environmentCoverageFields,
  environmentCoverageViewRequestSchema,
} from "./environmentCoverageView.js";
import { environmentManifestFields } from "./environmentManifestSchema.js";
import { environmentManifestViewRequestSchema } from "./environmentManifestView.js";
import {
  environmentStateFields,
  environmentStateViewRequestSchema,
} from "./environmentStateView.js";
import { evmViewItemSchema, evmViewRequestSchema } from "./evmInterfaceView.js";
import {
  goBinaryViewContextSchema,
  goBinaryViewPageSchema,
  goBinaryViewRequestSchema,
} from "./goBinaryView.js";
import {
  il2cppMetadataViewContextSchema,
  il2cppMetadataViewItemsSchema,
  il2cppMetadataViewRequestSchema,
} from "./il2cppMetadataView.js";
import {
  interfaceBuilderViewContextSchema,
  interfaceBuilderViewItemsSchema,
  interfaceBuilderViewRequestSchema,
} from "./interfaceBuilderView.js";
import { javascriptApplicationSourceCoverageSchema } from "./javascriptApplicationCoverage.js";
import {
  javascriptFactRowSchema,
  javascriptFactsViewRequestSchema,
} from "./javascriptFactsView.js";
import {
  javascriptModuleReferenceSchema,
  javascriptModuleReferencesRequestSchema,
} from "./javascriptModuleReferences.js";
import {
  machoViewContextSchema,
  machoViewRequestSchema,
  machoViewRows,
} from "./machoView.js";
import {
  managedViewContextSchema,
  managedViewItemSchema,
  managedViewRequestSchema,
} from "./managedArtifactView.js";
import {
  managedMembersViewContextSchema,
  managedMembersViewPageSchema,
  managedMembersViewRequestSchema,
} from "./managedMemberViewSchemas.js";
import {
  nativeExportsSummarySchema,
  nativeExportsViewItemsSchema,
  nativeExportsViewRequestSchema,
} from "./nativeExportsView.js";
import {
  nativeFeatureTraceRequests,
  nativeFeatureTraceSummarySchema,
  nativeFeatureTraceViewItems,
} from "./nativeFeatureTraceView.js";
import {
  nativeFunctionMatchingViewItemsSchema,
  nativeFunctionMatchingViewRequestSchema,
} from "./nativeFunctionMatchingView.js";
import {
  nativeInstructionReferenceContextSchema,
  nativeInstructionReferenceItemsSchema,
  nativeInstructionReferencesRequestSchema,
} from "./nativeInstructionReferencesView.js";
import {
  nativeInventoryViewRequestSchema,
  nativeInventoryViewRowSchema,
} from "./nativeInventoryView.js";
import {
  nativeLoadImageViewItemsSchema,
  nativeLoadImageViewRequestSchema,
} from "./nativeLoadImageView.js";
import {
  nativeContextItemsSchemas,
  nativeContextViewRequestSchema,
  nativeObservationOperationSchema,
  nativeObservationViewRequestSchema,
  nativeSourceContextReferenceSchema,
} from "./nativeObservationSchemas.js";
import {
  procedureReferenceSummarySchema,
  procedureReferenceViewItems,
  procedureReferenceViewRequests,
} from "./nativeProcedureReferencesView.js";
import { nativeViewSourceContext } from "./nativeViewContext.js";
import {
  pcapViewPageSchema,
  pcapViewRequestSchema,
} from "./pcapCaptureView.js";
import {
  protobufViewContextSchema,
  protobufViewItemsSchema,
  protobufViewRequestSchema,
} from "./protobufCaptureView.js";
import {
  qlogViewContextSchema,
  qlogViewPageSchema,
  qlogViewRequestSchema,
} from "./qlogCaptureView.js";
import {
  rustBinarySummarySchema,
  rustBinaryViewContextSchema,
} from "./rustBinaryView.js";
import {
  unrealPakViewContextSchema,
  unrealPakViewItemsSchema,
  unrealPakViewRequestSchema,
} from "./unrealPakView.js";
import {
  wasmViewItemSchema,
  wasmViewRequestSchema,
} from "./wasmArtifactView.js";
import {
  captureViewItemsSchema,
  captureViewRequestSchema,
} from "./webNetworkCaptureView.js";

import {
  androidClassSummaryViewResultSchema,
  androidComponentSummaryViewResultSchema,
  androidComponentsViewResultSchema,
  androidJniPageViewResultSchema,
  androidJniSummaryViewResultSchema,
  androidManifestViewResultSchema,
  androidMethodSummaryViewResultSchema,
  androidPackageSummaryViewResultSchema,
} from "./summarySchemas/androidSummarySchemas.js";
import {
  apiContractPageViewResultSchema,
  apiContractSummaryViewResultSchema,
  graphqlContractPageViewResultSchema,
} from "./summarySchemas/apiContractSummarySchemas.js";
import {
  apkSignaturePageViewResultSchema,
  apkSignatureSummaryViewResultSchema,
} from "./summarySchemas/apkSignatureSummarySchema.js";
import { artifactInventorySummaryViewResultSchema } from "./summarySchemas/artifactInventorySummarySchema.js";
import { batchDecompileSummaryViewResultSchema } from "./summarySchemas/batchDecompileSummarySchema.js";
import { binaryLayoutSummaryViewResultSchema } from "./summarySchemas/binaryLayoutSummarySchema.js";
import { browserScenarioSummaryViewResultSchema } from "./summarySchemas/browserScenarioSummarySchema.js";
import { byteEntropySummaryViewResultSchema } from "./summarySchemas/byteEntropySummarySchema.js";
import { dartAotSummaryViewResultSchema } from "./summarySchemas/dartAotSummarySchema.js";
import { desktopApplicationSummaryViewResultSchema } from "./summarySchemas/desktopApplicationSummarySchema.js";
import { devicetreeSummaryViewResultSchema } from "./summarySchemas/devicetreeSummarySchema.js";
import {
  uefiExtractionPageViewResultSchema,
  uefiExtractionSummaryViewResultSchema,
} from "./summarySchemas/uefiExtractionSummarySchema.js";
import {
  uefiFirmwarePageViewResultSchema,
  uefiFirmwareSummaryViewResultSchema,
} from "./summarySchemas/uefiFirmwareSummarySchema.js";
import { elfDependenciesSummaryViewResultSchema } from "./summarySchemas/elfDependenciesSummarySchema.js";
import {
  endpointComparisonPageViewResultSchema,
  endpointComparisonSummaryViewResultSchema,
} from "./summarySchemas/endpointComparisonSummarySchemas.js";
import {
  erlangBeamSummaryViewResultSchema,
  erlangBeamTableViewResultSchema,
} from "./summarySchemas/erlangBeamSummarySchemas.js";
import { evmInterfaceSummaryViewResultSchema } from "./summarySchemas/evmInterfaceSummarySchema.js";
import {
  featureTraceSummaryViewResultSchema,
  featureTraceViewResultSchema,
} from "./summarySchemas/featureTraceSummarySchemas.js";
import { fridaSessionStatusSummaryViewResultSchema } from "./summarySchemas/fridaSessionStatusSummarySchema.js";
import { gdbCommandSummaryViewResultSchema } from "./summarySchemas/gdbCommandSummarySchema.js";
import { goBinarySummaryViewResultSchema } from "./summarySchemas/goBinarySummarySchema.js";
import {
  gpuCodeObjectsPageViewResultSchema,
  gpuCodeObjectsSummaryViewResultSchema,
} from "./summarySchemas/gpuCodeObjectsSummarySchemas.js";
import { il2cppMetadataSummaryViewResultSchema } from "./summarySchemas/il2cppMetadataSummarySchema.js";
import { interfaceBuilderSummaryViewResultSchema } from "./summarySchemas/interfaceBuilderSummarySchema.js";
import { javascriptApplicationSummaryViewResultSchema } from "./summarySchemas/javascriptApplicationSummarySchema.js";
import { javaScriptRoutesViewResultSchema } from "./summarySchemas/javascriptRoutesSummarySchema.js";
import { machoSummaryViewResultSchema } from "./summarySchemas/machoSummarySchema.js";
import {
  managedArtifactSummaryViewResultSchema,
  managedMemberSummaryViewResultSchema,
} from "./summarySchemas/managedSummarySchemas.js";
import {
  modelArtifactPageViewResultSchema,
  modelArtifactSummaryViewResultSchema,
} from "./summarySchemas/modelArtifactSummarySchemas.js";
import { nativeExportsSummaryViewResultSchema } from "./summarySchemas/nativeExportsSummarySchema.js";
import { nativeFeatureTraceSummaryViewResultSchema } from "./summarySchemas/nativeFeatureTraceSummarySchema.js";
import { nativeFunctionMatchingSummaryViewResultSchema } from "./summarySchemas/nativeFunctionMatchingSummarySchema.js";
import { nativeFunctionSummaryViewResultSchema } from "./summarySchemas/nativeFunctionSummarySchema.js";
import { nativeInventorySummaryViewResultSchema } from "./summarySchemas/nativeInventorySummarySchema.js";
import { nativeLoadImageSummaryViewResultSchema } from "./summarySchemas/nativeLoadImageSummarySchema.js";
import { nativeObservationSummaryViewResultSchemas } from "./summarySchemas/nativeObservationSummarySchemas.js";
import { nativeProcedureReferencesSummaryViewResultSchema } from "./summarySchemas/nativeProcedureReferencesSummarySchema.js";
import { nativeValueTraceSummaryViewResultSchema } from "./summarySchemas/nativeValueTraceSummarySchema.js";
import { nugetNupkgSummaryViewResultSchema } from "./summarySchemas/nugetNupkgSummarySchema.js";
import { objdumpSummaryViewResultSchema } from "./summarySchemas/objdumpSummarySchema.js";
import { pcapCaptureSummaryViewResultSchema } from "./summarySchemas/pcapCaptureSummarySchema.js";
import {
  playwrightTracePageViewResultSchema,
  playwrightTraceSummaryViewResultSchema,
} from "./summarySchemas/playwrightTraceSummarySchemas.js";
import { procedurePseudocodeSummaryViewResultSchema } from "./summarySchemas/procedurePseudocodeSummarySchema.js";
import {
  pythonPycCodeObjectsViewResultSchema,
  pythonPycSummaryViewResultSchema,
} from "./summarySchemas/pythonPycSummarySchemas.js";
import {
  rustBinaryPageViewResultSchema,
  rustBinarySummaryViewResultSchema,
} from "./summarySchemas/rustBinarySummarySchemas.js";
import {
  sourceToBundlePageViewResultSchema,
  sourceToBundleSummaryViewResultSchema,
} from "./summarySchemas/sourceToBundleSummarySchemas.js";
import { unrealPakSummaryViewResultSchema } from "./summarySchemas/unrealPakSummarySchema.js";
import { wasmArtifactSummaryViewResultSchema } from "./summarySchemas/wasmArtifactSummarySchema.js";
import {
  webBundlePageViewResultSchema,
  webBundleSummaryViewResultSchema,
} from "./summarySchemas/webBundleSummarySchemas.js";
import { webNetworkCaptureSummaryViewResultSchema } from "./summarySchemas/webNetworkCaptureSummarySchema.js";
import {
  webSourceLocationMatchesViewResultSchema,
  webSourceLocationSummaryViewResultSchema,
  webSourceLocationTextViewResultSchema,
} from "./summarySchemas/webSourceLocationSummarySchemas.js";

export {
  androidClassSummaryViewResultSchema,
  androidComponentSummaryViewResultSchema,
  androidComponentsViewResultSchema,
  androidJniPageViewResultSchema,
  androidJniSummaryViewResultSchema,
  androidManifestViewResultSchema,
  androidMethodSummaryViewResultSchema,
  androidPackageSummaryViewResultSchema,
  apiContractPageViewResultSchema,
  apiContractSummaryViewResultSchema,
  apkSignaturePageViewResultSchema,
  apkSignatureSummaryViewResultSchema,
  artifactInventorySummaryViewResultSchema,
  batchDecompileSummaryViewResultSchema,
  binaryLayoutSummaryViewResultSchema,
  browserScenarioSummaryViewResultSchema,
  byteEntropySummaryViewResultSchema,
  dartAotSummaryViewResultSchema,
  desktopApplicationSummaryViewResultSchema,
  devicetreeSummaryViewResultSchema,
  elfDependenciesSummaryViewResultSchema,
  endpointComparisonPageViewResultSchema,
  endpointComparisonSummaryViewResultSchema,
  erlangBeamSummaryViewResultSchema,
  erlangBeamTableViewResultSchema,
  evmInterfaceSummaryViewResultSchema,
  featureTraceSummaryViewResultSchema,
  featureTraceViewResultSchema,
  fridaSessionStatusSummaryViewResultSchema,
  gdbCommandSummaryViewResultSchema,
  goBinarySummaryViewResultSchema,
  gpuCodeObjectsPageViewResultSchema,
  gpuCodeObjectsSummaryViewResultSchema,
  graphqlContractPageViewResultSchema,
  il2cppMetadataSummaryViewResultSchema,
  interfaceBuilderSummaryViewResultSchema,
  javascriptApplicationSummaryViewResultSchema,
  javaScriptRoutesViewResultSchema,
  machoSummaryViewResultSchema,
  managedArtifactSummaryViewResultSchema,
  managedMemberSummaryViewResultSchema,
  modelArtifactPageViewResultSchema,
  modelArtifactSummaryViewResultSchema,
  nativeExportsSummaryViewResultSchema,
  unrealPakSummaryViewResultSchema,
  nativeFeatureTraceSummaryViewResultSchema,
  nativeFunctionMatchingSummaryViewResultSchema,
  nativeFunctionSummaryViewResultSchema,
  nativeInventorySummaryViewResultSchema,
  nativeLoadImageSummaryViewResultSchema,
  nativeObservationSummaryViewResultSchemas,
  nativeProcedureReferencesSummaryViewResultSchema,
  nativeValueTraceSummaryViewResultSchema,
  nugetNupkgSummaryViewResultSchema,
  objdumpSummaryViewResultSchema,
  pcapCaptureSummaryViewResultSchema,
  playwrightTracePageViewResultSchema,
  playwrightTraceSummaryViewResultSchema,
  procedurePseudocodeSummaryViewResultSchema,
  pythonPycCodeObjectsViewResultSchema,
  pythonPycSummaryViewResultSchema,
  rustBinaryPageViewResultSchema,
  rustBinarySummaryViewResultSchema,
  sourceToBundlePageViewResultSchema,
  sourceToBundleSummaryViewResultSchema,
  uefiExtractionPageViewResultSchema,
  uefiExtractionSummaryViewResultSchema,
  uefiFirmwarePageViewResultSchema,
  uefiFirmwareSummaryViewResultSchema,
  wasmArtifactSummaryViewResultSchema,
  webBundlePageViewResultSchema,
  webBundleSummaryViewResultSchema,
  webNetworkCaptureSummaryViewResultSchema,
  webSourceLocationMatchesViewResultSchema,
  webSourceLocationSummaryViewResultSchema,
  webSourceLocationTextViewResultSchema,
};

const viewResultBase = {
  ...viewResultBaseFields,
  parent_operation: z.enum([
    "trace_web_source_location",
    "inspect_python_pyc",
    "inspect_nuget_nupkg",
    "inspect_erlang_beam",
    "inspect_devicetree",
    "inspect_byte_entropy",
    "inspect_native_exports",
    "inspect_elf_dependencies",
    "inspect_binary_layout",
    "inspect_go_binary",
    "gdb_console",
    "frida_session_status",
    "inspect_with_objdump",
    "inspect_desktop_application",
    "analyze_javascript_application",
    "analyze_web_bundle",
    "analyze_function",
    "procedure_pseudo_code",
    "inspect_artifact",
    "inventory_artifact",
    "inspect_wasm_artifact",
    "inspect_macho",
    "decode_interface_builder",
    "inspect_evm_interface",
    "inspect_managed_artifact",
    "inspect_managed_members",
    "inspect_web_network_capture",
    "inspect_android_package",
    "inspect_android_class",
    "inspect_android_method",
    "inspect_android_jni_bindings",
    "inspect_pcap_capture",
    "inspect_dart_aot",
    "inspect_il2cpp_metadata",
    "inspect_model_artifact",
    "inspect_unreal_pak",
    "inspect_gpu_code_objects",
    ...NATIVE_INVENTORY_OPERATIONS,
    ...NATIVE_OBSERVATION_OPERATIONS,
    "trace_native_values",
    "match_native_functions",
    "procedure_references",
  ]),
} as const;

const nativeObservationSummaryViewResultSchema = z.discriminatedUnion(
  "parent_operation",
  [
    nativeObservationSummaryViewResultSchemas.procedure_address,
    nativeObservationSummaryViewResultSchemas.procedure_callees,
    nativeObservationSummaryViewResultSchemas.procedure_callers,
    nativeObservationSummaryViewResultSchemas.xrefs,
    nativeObservationSummaryViewResultSchemas.resolve_containing_procedure,
    nativeObservationSummaryViewResultSchemas.get_call_graph,
  ],
);
const nativeObservationPageFor = <Operation extends NativeObservationOperation>(
  operation: Operation,
) =>
  nativeObservationSummaryViewResultSchemas[operation]
    .omit({ kind: true, view: true })
    .extend({
      kind: z.literal("native-observation"),
      view: nativeObservationViewRequestSchema,
    });
const nativeObservationPageViewResultSchema = z.discriminatedUnion(
  "parent_operation",
  [
    nativeObservationPageFor("procedure_address"),
    nativeObservationPageFor("procedure_callees"),
    nativeObservationPageFor("procedure_callers"),
    nativeObservationPageFor("xrefs"),
    nativeObservationPageFor("resolve_containing_procedure"),
    nativeObservationPageFor("get_call_graph"),
  ],
);
const nativeContextFor = <Facet extends keyof typeof nativeContextItemsSchemas>(
  facet: Facet,
) =>
  z.strictObject({
    ...viewResultBase,
    ...nativeViewSourceContext,
    kind: z.literal("native-context"),
    artifact: artifactSchema.nullable(),
    parent_operation: nativeObservationOperationSchema,
    source_context: nativeSourceContextReferenceSchema,
    facet: z.literal(facet),
    view: nativeContextViewRequestSchema.extend({ facet: z.literal(facet) }),
    items: nativeContextItemsSchemas[facet],
  });
const nativeContextViewResultSchema = z.discriminatedUnion("facet", [
  nativeContextFor("overview"),
  nativeContextFor("analysis-profile"),
  nativeContextFor("limitations"),
  nativeContextFor("result-limitations").extend({
    coverage: nullableCollectionViewCoverageSchema,
  }),
]);

/** One CycloneDX 1.6 document. This view does not page. */
export const cycloneDxViewResultSchema = z.strictObject({
  ...viewResultBase,
  kind: z.literal("cyclonedx"),
  parent_operation: z.enum(["inspect_go_binary", "inspect_rust_binary"]),
  view: cycloneDxViewRequestSchema,
  source_coverage: cycloneDxSourceCoverageSchema,
  document: cycloneDxDocumentSchema,
});

/** Typed reference page; full item observations remain available separately. */
export const javascriptModuleReferencesViewResultSchema = z.strictObject({
  ...viewResultBase,
  kind: z.literal("javascript"),
  view: javascriptModuleReferencesRequestSchema,
  parent_operation: z.literal("analyze_javascript_application"),
  rows: z.array(javascriptModuleReferenceSchema),
  source_coverage: javascriptApplicationSourceCoverageSchema,
});

/** Paged retained observations with exact selected properties and provenance. */
const javascriptFactsViewResultSchema = z.strictObject({
  ...viewResultBase,
  kind: z.literal("javascript-facts"),
  view: javascriptFactsViewRequestSchema,
  parent_operation: z.literal("analyze_javascript_application"),
  rows: z.array(javascriptFactRowSchema),
  source_coverage: javascriptApplicationSourceCoverageSchema,
});

const androidPackageViewResultSchema = z.discriminatedUnion("facet", [
  androidManifestViewResultSchema,
  androidComponentsViewResultSchema,
  androidComponentSummaryViewResultSchema,
]);

const nativeFeatureTracePage = <
  Collection extends keyof typeof nativeFeatureTraceViewItems,
>(
  collection: Collection,
) =>
  z.strictObject({
    ...viewResultBase,
    ...nativeViewSourceContext,
    artifact: artifactSchema.nullable(),
    kind: z.literal("native-feature-trace"),
    parent_operation: z.literal("trace_feature"),
    view: nativeFeatureTraceRequests[collection],
    summary: nativeFeatureTraceSummarySchema,
    items: nativeFeatureTraceViewItems[collection],
  });
const nativeFeatureTracePageViewResultSchema = z
  .object({ kind: z.literal("native-feature-trace") })
  .passthrough()
  .pipe(
    z.union([
      nativeFeatureTracePage("matches"),
      nativeFeatureTracePage("references"),
      nativeFeatureTracePage("unknowns"),
    ]),
  );

const procedureReferencePage = <
  Collection extends keyof typeof procedureReferenceViewRequests,
>(
  collection: Collection,
) =>
  z.strictObject({
    ...viewResultBase,
    ...nativeViewSourceContext,
    kind: z.literal("native-procedure-references"),
    parent_operation: z.literal("procedure_references"),
    artifact: artifactSchema.nullable(),
    view: procedureReferenceViewRequests[collection],
    summary: procedureReferenceSummarySchema,
    items: procedureReferenceViewItems[collection],
    byte_limited: z.boolean(),
  });
const procedureReferencePageViewResultSchema = z
  .object({ kind: z.literal("native-procedure-references") })
  .passthrough()
  .pipe(
    z.union([
      procedureReferencePage("references"),
      procedureReferencePage("unresolved_calls"),
    ]),
  );

const batchDecompilePage = {
  ...viewResultBase,
  ...batchDecompileViewContextSchema.shape,
  kind: z.literal("batch-decompile"),
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("batch_decompile"),
};
// The kind tag keeps dispatch while each collection keeps exactly its own shape.
export const batchDecompileViewResultSchema = z
  .object({ kind: z.literal("batch-decompile") })
  .passthrough()
  .pipe(
    z.union([
      z.strictObject({
        ...batchDecompilePage,
        view: batchDecompileViewCollections.items.request,
        items: batchDecompileViewCollections.items.rows,
      }),
      z.strictObject({
        ...batchDecompilePage,
        view: batchDecompileViewCollections.pseudocode.request,
        item: batchDecompileViewCollections.pseudocode.item,
      }),
    ]),
  );

/** Bind the existing nested facet selection to its producer-owned rows. */
const machoPage = <Facet extends keyof typeof machoViewRows>(facet: Facet) =>
  z.strictObject({
    ...viewResultBase,
    ...machoViewContextSchema.shape,
    kind: z.literal("macho"),
    parent_operation: z.literal("inspect_macho"),
    view: machoViewRequestSchema.extend({ facet: z.literal(facet) }),
    item: machoViewRows[facet],
  });

// The input tag preserves kind dispatch; the output projection advertises the
// correlated pages without adding a discriminator to their public wire shape.
const machoPageViewResultSchema = z
  .object({ kind: z.literal("macho") })
  .passthrough()
  .pipe(
    z.union([
      machoPage("entrypoints"),
      machoPage("architectures"),
      machoPage("build_metadata"),
      machoPage("load_commands"),
      machoPage("dependencies"),
      machoPage("imports"),
      machoPage("exports"),
      machoPage("segments"),
      machoPage("encryption"),
      machoPage("provenance"),
    ]),
  );

/** Projected facts for one selected view of retained analysis Evidence. */
export const analysisViewResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...viewResultBase,
    ...nativeViewSourceContext,
    source_parameters: jsonObjectSchema
      .nullable()
      .describe(
        "Null means source parameters were omitted to fit the page; retrieve the parent Evidence.",
      ),
    parent_operation: z.string(),
    artifact: artifactSchema.nullable(),
    kind: z.literal("recorded-array"),
    view: recordedArrayViewSchema,
    rows: z.array(jsonValueSchema),
  }),
  playwrightTracePageViewResultSchema,
  z.strictObject({
    ...viewResultBase,
    ...nativeViewSourceContext,
    kind: z.literal("native-instruction-references"),
    parent_operation: z.literal("inspect_native_instruction"),
    artifact: artifactSchema.nullable(),
    view: nativeInstructionReferencesRequestSchema,
    instruction: nativeInstructionReferenceContextSchema,
    items: nativeInstructionReferenceItemsSchema,
    coverage: analysisViewCoverageSchema.nullable(),
    byte_limited: z.boolean(),
  }),
  nativeObservationPageViewResultSchema,
  nativeContextViewResultSchema,
  javaScriptRoutesViewResultSchema,
  webBundlePageViewResultSchema,
  sourceToBundlePageViewResultSchema,
  endpointComparisonPageViewResultSchema,
  apiContractPageViewResultSchema,
  graphqlContractPageViewResultSchema,
  featureTraceViewResultSchema,
  batchDecompileViewResultSchema,
  z.strictObject({
    ...viewResultBase,
    ...nativeFunctionMatchingContextSchema.shape,
    kind: z.literal("function-matches"),
    artifact: z.null(),
    view: nativeFunctionMatchingViewRequestSchema,
    items: nativeFunctionMatchingViewItemsSchema,
    byte_limited: z.boolean().optional(),
    parent_operation: z.literal("match_native_functions"),
  }),
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
    ...viewResultBase,
    ...environmentManifestFields,
    kind: z.literal("environment-manifest"),
    parent_operation: z.enum([
      "inspect_web_network_capture",
      "capture_browser_scenario",
    ]),
    view: environmentManifestViewRequestSchema,
  }),
  z.strictObject({
    ...viewResultBase,
    ...environmentStateFields,
    kind: z.literal("environment-state"),
    parent_operation: z.enum([
      "inspect_web_network_capture",
      "capture_browser_scenario",
    ]),
    view: environmentStateViewRequestSchema,
  }),
  z.strictObject({
    ...viewResultBase,
    ...environmentCoverageFields,
    kind: z.literal("environment-coverage"),
    parent_operation: z.enum([
      "inspect_web_network_capture",
      "capture_browser_scenario",
    ]),
    view: environmentCoverageViewRequestSchema,
  }),
  z.discriminatedUnion("parent_operation", [
    webSourceLocationSummaryViewResultSchema,
    procedurePseudocodeSummaryViewResultSchema,
    nativeObservationSummaryViewResultSchema,
    nativeValueTraceSummaryViewResultSchema,
    erlangBeamSummaryViewResultSchema,
    devicetreeSummaryViewResultSchema,
    uefiFirmwareSummaryViewResultSchema,
    uefiExtractionSummaryViewResultSchema,
    pythonPycSummaryViewResultSchema,
    nativeExportsSummaryViewResultSchema,
    elfDependenciesSummaryViewResultSchema,
    byteEntropySummaryViewResultSchema,
    gdbCommandSummaryViewResultSchema,
    objdumpSummaryViewResultSchema,
    fridaSessionStatusSummaryViewResultSchema,
    goBinarySummaryViewResultSchema,
    rustBinarySummaryViewResultSchema,
    binaryLayoutSummaryViewResultSchema,
    desktopApplicationSummaryViewResultSchema,
    javascriptApplicationSummaryViewResultSchema,
    artifactInventorySummaryViewResultSchema,
    wasmArtifactSummaryViewResultSchema,
    machoSummaryViewResultSchema,
    interfaceBuilderSummaryViewResultSchema,
    evmInterfaceSummaryViewResultSchema,
    managedArtifactSummaryViewResultSchema,
    managedMemberSummaryViewResultSchema,
    webNetworkCaptureSummaryViewResultSchema,
    browserScenarioSummaryViewResultSchema,
    androidPackageSummaryViewResultSchema,
    androidJniSummaryViewResultSchema,
    androidClassSummaryViewResultSchema,
    androidMethodSummaryViewResultSchema,
    pcapCaptureSummaryViewResultSchema,
    dartAotSummaryViewResultSchema,
    il2cppMetadataSummaryViewResultSchema,
    apkSignatureSummaryViewResultSchema,
    modelArtifactSummaryViewResultSchema,
    unrealPakSummaryViewResultSchema,
    gpuCodeObjectsSummaryViewResultSchema,
    nativeInventorySummaryViewResultSchema,
    nativeFeatureTraceSummaryViewResultSchema,
    nativeProcedureReferencesSummaryViewResultSchema,
    nativeLoadImageSummaryViewResultSchema,
    nativeFunctionMatchingSummaryViewResultSchema,
    nativeFunctionSummaryViewResultSchema,
    sourceToBundleSummaryViewResultSchema,
    endpointComparisonSummaryViewResultSchema,
    apiContractSummaryViewResultSchema,
    playwrightTraceSummaryViewResultSchema,
    featureTraceSummaryViewResultSchema,
    batchDecompileSummaryViewResultSchema,
    webBundleSummaryViewResultSchema,
    nugetNupkgSummaryViewResultSchema,
  ]),
  z.strictObject({
    ...viewResultBase,
    kind: z.literal("devicetree"),
    parent_operation: z.literal("inspect_devicetree"),
    view: devicetreeViewRequestSchema,
    devicetree: devicetreePageContextSchema,
    items: devicetreeViewItemsSchema,
  }),
  uefiFirmwarePageViewResultSchema,
  uefiExtractionPageViewResultSchema,
  webSourceLocationMatchesViewResultSchema,
  webSourceLocationTextViewResultSchema,
  erlangBeamTableViewResultSchema,
  pythonPycCodeObjectsViewResultSchema,
  z.strictObject({
    ...viewResultBase,
    kind: z.literal("native-exports"),
    parent_operation: z.literal("inspect_native_exports"),
    view: nativeExportsViewRequestSchema,
    exports: nativeExportsSummarySchema,
    items: nativeExportsViewItemsSchema,
  }),
  z.strictObject({
    ...viewResultBase,
    kind: z.literal("elf-dependencies"),
    parent_operation: z.literal("inspect_elf_dependencies"),
    view: elfDependenciesViewRequestSchema,
    dependencies: elfDependenciesSummarySchema,
    items: elfDependenciesViewItemsSchema,
  }),
  z.strictObject({
    ...viewResultBase,
    ...nativeViewSourceContext,
    kind: z.literal("native-inventory"),
    parent_operation: nativeInventoryOperationSchema,
    artifact: artifactSchema.nullable(),
    view: nativeInventoryViewRequestSchema,
    rows: z.array(nativeInventoryViewRowSchema),
  }),
  nativeFeatureTracePageViewResultSchema,
  procedureReferencePageViewResultSchema,
  z.strictObject({
    ...viewResultBase,
    kind: z.literal("native-load-image"),
    coverage: nullableCollectionViewCoverageSchema,
    ...nativeViewSourceContext,
    verification_status: z.enum(["unsupported", "verified", "mismatch"]),
    parent_operation: z.literal("inspect_native_load_image"),
    artifact: artifactSchema.nullable(),
    view: nativeLoadImageViewRequestSchema,
    items: nativeLoadImageViewItemsSchema,
  }),
  z.strictObject({
    kind: z.literal("protobuf"),
    view: protobufViewRequestSchema,
    items: protobufViewItemsSchema,
    ...viewResultBase,
    ...protobufViewContextSchema.shape,
    parent_operation: z.literal("inspect_web_network_capture"),
  }),
  z.strictObject({
    kind: z.literal("capture"),
    view: captureViewRequestSchema,
    items: captureViewItemsSchema,
    ...viewResultBase,
    parent_operation: z.literal("inspect_web_network_capture"),
  }),
  z.strictObject({
    kind: z.literal("browser-scenario"),
    view: browserScenarioViewRequestSchema,
    items: browserScenarioViewItemsSchema,
    ...viewResultBase,
    coverage: nullableCollectionViewCoverageSchema,
    ...browserScenarioViewContextSchema.shape,
    artifact: z.null(),
    parent_operation: z.literal("capture_browser_scenario"),
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
    source_coverage: knownCoverageStatusSchema,
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
    ...viewResultBase,
    ...goBinaryViewContextSchema.shape,
    coverage: nullableCollectionViewCoverageSchema,
    kind: z.literal("go"),
    parent_operation: z.literal("inspect_go_binary"),
    view: goBinaryViewRequestSchema,
    page: goBinaryViewPageSchema,
  }),
  rustBinaryPageViewResultSchema,
  cycloneDxViewResultSchema,
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
  javascriptModuleReferencesViewResultSchema,
  javascriptFactsViewResultSchema,
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
    kind: z.literal("desktop-application"),
    view: desktopViewRequestSchema,
    items: desktopViewItemsSchema,
    ...viewResultBase,
    source_coverage: desktopCoverageSchema,
    parent_operation: z.literal("inspect_desktop_application"),
  }),
  machoPageViewResultSchema,
  z.strictObject({
    kind: z.literal("interface-builder"),
    view: interfaceBuilderViewRequestSchema,
    items: interfaceBuilderViewItemsSchema,
    ...viewResultBase,
    resource_root: bundleResourceRootSchema.optional(),
    ...interfaceBuilderViewContextSchema.shape,
    parent_operation: z.literal("decode_interface_builder"),
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
    kind: z.literal("managed-members"),
    view: managedMembersViewRequestSchema,
    page: managedMembersViewPageSchema,
    ...viewResultBase,
    ...managedMembersViewContextSchema.shape,
    parent_operation: z.literal("inspect_managed_members"),
  }),
  androidPackageViewResultSchema,
  androidJniPageViewResultSchema,
  z.strictObject({
    kind: z.literal("dart-aot"),
    view: dartAotViewRequestSchema,
    items: z.array(z.string()),
    ...viewResultBase,
    ...dartAotViewContextSchema.shape,
    parent_operation: z.literal("inspect_dart_aot"),
  }),
  apkSignaturePageViewResultSchema,
  modelArtifactPageViewResultSchema,
  gpuCodeObjectsPageViewResultSchema,
  z.strictObject({
    kind: z.literal("il2cpp-metadata"),
    view: il2cppMetadataViewRequestSchema,
    items: il2cppMetadataViewItemsSchema,
    ...viewResultBase,
    ...il2cppMetadataViewContextSchema.shape,
    parent_operation: z.literal("inspect_il2cpp_metadata"),
  }),
  z.strictObject({
    kind: z.literal("unreal-pak"),
    view: unrealPakViewRequestSchema,
    items: unrealPakViewItemsSchema,
    ...viewResultBase,
    ...unrealPakViewContextSchema.shape,
    parent_operation: z.literal("inspect_unreal_pak"),
  }),
  z.strictObject({
    kind: z.literal("inventory"),
    view: artifactInventoryViewRequestSchema,
    source_coverage: artifactInventoryCoverageSchema.exactOptional(),
    manifest: artifactGraphManifestSchema,
    inventory_evidence_ids: z.array(prefixedDigestSchema("ev")).min(1),
    source_complete: z.boolean(),
    items: artifactInventoryItemsSchema,
    ...viewResultBase,
  }),
]);

export type AnalysisViewResult = z.output<typeof analysisViewResultSchema>;

/** View payload before the content digest is attached. */
type WithoutViewDigest<T> = T extends { readonly view_digest: string }
  ? Omit<T, "view_digest">
  : never;
export type UnsignedAnalysisView = WithoutViewDigest<AnalysisViewResult>;
