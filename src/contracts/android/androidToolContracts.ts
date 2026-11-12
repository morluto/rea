import { z } from "zod";
import {
  androidInputSchemas,
  androidPackageInspectionInputSchema,
  androidSymbolInspectionInputSchemas,
  androidResultSchemas,
  androidJniInspectionInputSchema,
  androidKotlinInspectionInputSchema,
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
  androidKotlinSummaryViewResultSchema,
  androidKotlinPageViewResultSchema,
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
    name: "inspect_android_kotlin_metadata",
    ...toolContractMetadata("inspect_android_kotlin_metadata"),
    description:
      "Report which classes in an explicit local APK carry kotlin.Metadata, from the raw annotations in its standard root classes*.dex members: per-DEX coverage, a metadata-version histogram, a declaration-kind histogram (class, file facade, synthetic class, multi-file facade/part, unknown) and listed classes with raw k/mv/pn/xi facts. Optional package_prefix and limit (default 100) narrow the listed classes; histograms and counts always cover every class. Omitted or complete detail lists at most 500 classes inline. Select detail summary to retain the complete inventory (up to a 4 MiB allowance; a shortfall is an explicit unknown, and narrowing with package_prefix lists the rest) and return a bounded summary with whole-APK histograms and a 64-class preview. Read later pages with inspect_analysis_view and the returned parent_evidence_id, using view {kind:android-kotlin,collection:classes,offset:0,limit:64,class_names,package_prefix,kinds,indices,fields:[...]}; follow coverage.next_offset until exhausted. With summary detail an optional view selects such a page directly; complete detail rejects a view. Select class_name to decode that exact class's declaration: class kind, modality, visibility, data/value/fun-interface flags, functions with suspend/inline/operator, nullable return and receiver types and their JVM/DEX prototypes (the same descriptors inspect_android_class reports), and properties with var/const and types. markers report static candidates only: root META-INF/*.kotlin_module entry count and names (contents unread) and counts of classes named androidx.compose., kotlinx.coroutines. or kotlin.coroutines., never runtime use, versions or completeness. Malformed or undecodable metadata stays explicit and a class without metadata is not proof it was not Kotlin. Does not load the decompiler or execute the APK. Requires caller-supplied JADX MCP JAR and JDK.",
    kind: "android-provider",
    inputSchema: androidKotlinInspectionInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        androidResultSchemas.inspect_android_kotlin_metadata,
        androidKotlinSummaryViewResultSchema,
        androidKotlinPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Summarize Kotlin usage in a package",
        input: {
          path: "/tmp/Example.apk",
          package_prefix: "com.example",
          limit: 50,
        },
      },
      {
        title: "Retain every Kotlin class and read the first page",
        input: {
          path: "/tmp/Example.apk",
          detail: "summary",
          view: { kind: "android-kotlin", collection: "classes", limit: 100 },
        },
      },
      {
        title: "Decode one class as Kotlin",
        input: {
          path: "/tmp/Example.apk",
          class_name: "com.example.api.ApiService",
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
      "Search complete top-level decompiler class-name rows in an explicit local APK by case-sensitive substring. Empty query inventories all rows. Repeated names remain repeated and appear in duplicate_names; the provider accepts only class names for lookup, so these rows do not identify which same-name class node a later lookup selects. Retains artifact and engine identity; no APK execution.",
    kind: "android-provider",
    inputSchema: androidInputSchemas.search_android_classes,
    outputSchema: evidenceResultOf(androidResultSchemas.search_android_classes),
    examples: [
      {
        title: "Find activity classes",
        input: { path: "/tmp/Example.apk", query: "Activity" },
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
      "Trace incoming static using nodes to an exact Android class or selected method overload. A method target may be an external class directly named by DEX invokes: target_definition external and reference_scope direct_dex_invokes identify this narrower inventory, without inventing a class definition or body. Ambiguous external requests list observed DEX prototypes; select overload_index explicitly. For APK-defined targets use inspect_android_class. The total counts containing nodes, not individual invokes. External callers include source_selector for inspect_android_method. Source lines and the containing node dex_offset remain unknown. direct_invokes carries exact DEX code-unit offsets when available; direct_invokes_exhaustive false marks byte-bounded partial instruction evidence, and null means unknown. No reflection, JNI or runtime dispatch is inferred.",
    kind: "android-provider",
    inputSchema: androidInputSchemas.trace_android_references,
    outputSchema: evidenceResultOf(
      androidResultSchemas.trace_android_references,
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
    ],
  },
] as const satisfies readonly ToolContract[];
