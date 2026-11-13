import { z } from "zod";
import {
  androidInputSchemas,
  androidPackageInspectionInputSchema,
  androidSymbolInspectionInputSchemas,
  androidResultSchemas,
  androidJniInspectionInputSchema,
  androidInventoryInspectionInputSchemas,
} from "../../domain/android/androidAnalysis.js";
import {
  androidPackageSummaryViewResultSchema,
  androidManifestViewResultSchema,
  androidComponentsViewResultSchema,
  androidComponentSummaryViewResultSchema,
  androidClassSummaryViewResultSchema,
  androidMethodSummaryViewResultSchema,
  androidJniSummaryViewResultSchema,
  androidJniPageViewResultSchema,
  androidClassesSummaryViewResultSchema,
  androidClassesPageViewResultSchema,
  androidReferencesSummaryViewResultSchema,
  androidReferencesPageViewResultSchema,
} from "../../domain/analysisView/analysisView.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Static APK operations backed by a separately supplied headless engine. */
export const ANDROID_TOOL_CONTRACTS = [
  {
    name: "inspect_android_jni_bindings",
    ...toolContractMetadata("inspect_android_jni_bindings"),
    description:
      "Link an APK's DEX native declarations to Java_* exports and static JNINativeMethod candidates by ABI and exact library occurrence, without executing it or loading libraries. Returns digests, relation IDs, slot/relocation provenance and explicit partial/unknown coverage; a candidate match does not prove uniqueness or runtime registration. Declaration filters and ABI/library filters narrow results; RegisterNatives attribution uses the full declaration inventory first. Default summary retains complete Evidence. Optional view kind android-jni selects bindings/declarations/candidates/libraries, fields and pages; use inspect_analysis_view with parent_evidence_id for later pages. Empty selections match none. Requires caller-supplied JADX MCP JAR and JDK.",
    kind: "android-provider",
    inputSchema: androidJniInspectionInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        androidResultSchemas.inspect_android_jni_bindings,
        androidJniSummaryViewResultSchema,
        androidJniPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Find one Conscrypt native implementation",
        input: {
          path: "/tmp/Example.apk",
          class_name: "org.conscrypt.NativeCrypto",
          method_names: ["EVP_PKEY_new_RSA"],
          abis: ["arm64-v8a"],
          detail: "summary",
        },
      },
    ],
  },
  {
    name: "inspect_android_package",
    ...toolContractMetadata("inspect_android_package"),
    description:
      "Inspect APK package/SDK/permission declarations, decoded manifest, static components and class/resource counts without executing it or verifying signatures. Requires caller-supplied JADX MCP JAR and JDK. Default complete returns full Evidence; detail summary retains it and omits manifest text/raw duplicates. With summary, view kind android selects facet components (exact filters, fields, paging), component-summary or manifest (UTF-16 text pages); complete detail rejects view. Use normalized_result.parent_evidence_id with inspect_analysis_view for later views. Component source_index identifies the original declaration, and declaration_coverage preserves unknowns.",
    kind: "android-provider",
    inputSchema: androidPackageInspectionInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        androidResultSchemas.inspect_android_package,
        androidPackageSummaryViewResultSchema,
        androidManifestViewResultSchema,
        androidComponentsViewResultSchema,
        androidComponentSummaryViewResultSchema,
      ]),
    ),
    examples: [
      { title: "Inspect an APK", input: { path: "/tmp/Example.apk" } },
      {
        title: "Inspect APK declarations with retained manifest",
        input: { path: "/tmp/Example.apk", detail: "summary" },
      },
      {
        title: "Read selected VIEW handlers with retained complete Evidence",
        input: {
          path: "/tmp/Example.apk",
          detail: "summary",
          view: {
            kind: "android",
            facet: "components",
            offset: 0,
            limit: 20,
            actions: ["android.intent.action.VIEW"],
            fields: [
              "kind",
              "name",
              "enabled",
              "process",
              "intent_filters",
              "location",
            ],
          },
        },
      },
    ],
  },
  {
    name: "search_android_classes",
    ...toolContractMetadata("search_android_classes"),
    description:
      "Search complete top-level decompiler class-name rows in an explicit local APK by case-sensitive substring. Empty query inventories all rows. Repeated names remain repeated and appear in duplicate_names; the provider accepts only class names for lookup, so these rows do not identify which same-name class node a later lookup selects. Retains artifact and engine identity; no APK execution. Omitted or complete detail returns every row inline, which costs about a million tokens on an APK with tens of thousands of classes. Select detail summary to retain the complete inventory and return a bounded summary: counts, a derived histogram of leading package prefixes and a 64-row preview. Read later pages with inspect_analysis_view and the returned parent_evidence_id, using view {kind:android-classes,collection:matches,offset:0,limit:64,package_prefix,class_names,indices} (or collection duplicate_names); follow coverage.next_offset until exhausted. With summary detail an optional view selects such a page directly; complete detail rejects a view.",
    kind: "android-provider",
    inputSchema: androidInventoryInspectionInputSchemas.search_android_classes,
    outputSchema: evidenceResultOf(
      z.union([
        androidResultSchemas.search_android_classes,
        androidClassesSummaryViewResultSchema,
        androidClassesPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Find activity classes",
        input: { path: "/tmp/Example.apk", query: "Activity" },
      },
      {
        title: "Summarize a large inventory and page one package",
        input: {
          path: "/tmp/Example.apk",
          query: "",
          detail: "summary",
          view: {
            kind: "android-classes",
            collection: "matches",
            package_prefix: "com.example.",
            limit: 100,
          },
        },
      },
    ],
  },
  {
    name: "inspect_android_class",
    ...toolContractMetadata("inspect_android_class"),
    description:
      "Inspect one exact Android class's methods, fields, inner classes, DEX prototypes and encoded static final values without generating source. Select an overload_index from these results for inspect_android_method; indices are artifact/engine-session scoped and prototypes are not complete raw method IDs. Optional mapping_path adds verified R8/ProGuard names separately; observed names remain primary. detail summary retains complete Evidence and returns normalized symbols without duplicate raw calls; complete remains the default.",
    kind: "android-provider",
    inputSchema: androidSymbolInspectionInputSchemas.inspect_android_class,
    outputSchema: evidenceResultOf(
      z.union([
        androidResultSchemas.inspect_android_class,
        androidClassSummaryViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Inspect a class",
        input: { path: "/tmp/Example.apk", class_name: "example.MainActivity" },
      },
      {
        title: "Annotate an obfuscated class with its R8 mapping",
        input: {
          path: "/tmp/Example.apk",
          class_name: "a.b",
          mapping_path: "/tmp/mapping.txt",
          detail: "summary",
        },
      },
    ],
  },
  {
    name: "inspect_android_method",
    ...toolContractMetadata("inspect_android_method"),
    description:
      "Decompile one Android method, with explicit overload_index when names collide and smali fallback when needed. Reports DEX prototype, representation, fallback markers and source truncation; display signatures may be aliases. Optional mapping_path annotates R8/ProGuard names without replacing observed names. detail summary retains complete Evidence and returns the selected body without duplicate class metadata; complete remains the default. Use inspect_android_class to choose the overload.",
    kind: "android-provider",
    inputSchema: androidSymbolInspectionInputSchemas.inspect_android_method,
    outputSchema: evidenceResultOf(
      z.union([
        androidResultSchemas.inspect_android_method,
        androidMethodSummaryViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Decompile a method",
        input: {
          path: "/tmp/Example.apk",
          class_name: "example.MainActivity",
          method_name: "onCreate",
        },
      },
    ],
  },
  {
    name: "trace_android_references",
    ...toolContractMetadata("trace_android_references"),
    description:
      "Trace incoming static using nodes to an exact Android class or selected method overload. A method target may be an external class directly named by DEX invokes: target_definition external and reference_scope direct_dex_invokes identify this narrower inventory, without inventing a class definition or body. Ambiguous external requests list observed DEX prototypes; select overload_index explicitly. For APK-defined targets use inspect_android_class. The total counts containing nodes, not individual invokes. External callers include source_selector for inspect_android_method. Source lines and the containing node dex_offset remain unknown. direct_invokes carries exact DEX code-unit offsets when available; direct_invokes_exhaustive false marks byte-bounded partial instruction evidence, and null means unknown. No reflection, JNI or runtime dispatch is inferred. Omitted or complete detail returns every using node inline, which can cost over a million tokens for a class referenced thousands of times. Select detail summary to retain the complete trace and return a bounded summary: counts, derived histograms by node kind and top-level class, and a 64-row preview without direct_invokes. Read later pages with inspect_analysis_view and the returned parent_evidence_id, using view {kind:android-references,collection:references,offset:0,limit:64,kinds,containing_classes,top_classes,indices,fields:[...]}; select fields direct_invokes to read raw invoke offsets; follow coverage.next_offset until exhausted. With summary detail an optional view selects such a page directly; complete detail rejects a view.",
    kind: "android-provider",
    inputSchema:
      androidInventoryInspectionInputSchemas.trace_android_references,
    outputSchema: evidenceResultOf(
      z.union([
        androidResultSchemas.trace_android_references,
        androidReferencesSummaryViewResultSchema,
        androidReferencesPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Find references to a class",
        input: { path: "/tmp/Example.apk", class_name: "example.MainActivity" },
      },
      {
        title: "Find APK callers of an observed external API prototype",
        input: {
          path: "/tmp/Example.apk",
          class_name: "android.app.NotificationManager",
          method_name: "notify",
          overload_index: 0,
        },
      },
      {
        title: "Summarize a heavily referenced class and page its callers",
        input: {
          path: "/tmp/Example.apk",
          class_name: "example.Util",
          detail: "summary",
          view: {
            kind: "android-references",
            collection: "references",
            top_classes: ["example.MainActivity"],
            limit: 50,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
