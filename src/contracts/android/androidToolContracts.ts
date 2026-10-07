import {
  androidInputSchemas,
  androidResultSchemas,
} from "../../domain/android/androidAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Static APK operations backed by a separately supplied headless engine. */
export const ANDROID_TOOL_CONTRACTS = [
  {
    name: "inspect_android_package",
    ...toolContractMetadata("inspect_android_package"),
    description:
      "Inspect a local APK's package, SDK and permission declarations, decoded manifest and class/resource counts. Does not execute the APK or verify signatures. Requires a caller-supplied JADX MCP JAR and JDK; uses one worker in an isolated temporary workspace.",
    kind: "android-provider",
    inputSchema: androidInputSchemas.inspect_android_package,
    outputSchema: evidenceResultOf(
      androidResultSchemas.inspect_android_package,
    ),
    examples: [
      { title: "Inspect an APK", input: { path: "/tmp/Example.apk" } },
    ],
  },
  {
    name: "search_android_classes",
    ...toolContractMetadata("search_android_classes"),
    description:
      "Search complete decompiler class names in an explicit local APK by case-sensitive substring. Empty query inventories all classes. Retains artifact and engine identity; no APK execution.",
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
      "Inspect one exact Android class's parsed methods, fields and inner classes, including synthetic members. Returns display signatures and explicit unknown DEX descriptors without generating source. Overload indices remain consistent within the artifact and engine session.",
    kind: "android-provider",
    inputSchema: androidInputSchemas.inspect_android_class,
    outputSchema: evidenceResultOf(androidResultSchemas.inspect_android_class),
    examples: [
      {
        title: "Inspect a class",
        input: { path: "/tmp/Example.apk", class_name: "example.MainActivity" },
      },
    ],
  },
  {
    name: "inspect_android_method",
    ...toolContractMetadata("inspect_android_method"),
    description:
      "Decompile one Android method with smali fallback. Requires explicit overload_index when multiple methods share a name. Reports representation, fallback markers and source truncation; never treats display signatures as exact DEX identities.",
    kind: "android-provider",
    inputSchema: androidInputSchemas.inspect_android_method,
    outputSchema: evidenceResultOf(androidResultSchemas.inspect_android_method),
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
      "Trace incoming static references to an exact Android class or unique method. Overloaded method reference queries are explicitly unsupported by the current engine. Source lines and DEX offsets remain unknown; no runtime calls are inferred.",
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
    ],
  },
] as const satisfies readonly ToolContract[];
