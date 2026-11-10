import { z } from "zod";
import {
  flutterInputSchemas,
  dartAotInspectionInputSchema,
  flutterResultSchemas,
} from "../../domain/flutter/flutterBuildAnalysis.js";
import { dartAotSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Flutter build identification by pure APK parsing. */
export const FLUTTER_TOOL_CONTRACTS = [
  {
    name: "identify_flutter_build",
    ...toolContractMetadata("identify_flutter_build"),
    description:
      "Identify a Flutter app's build facts by pure parsing: observed Dart snapshot hashes from lib/<abi>/libapp.so, per-ABI library digests, the engine library's GNU build-id, and any labeled Dart version or toolchain strings libflutter.so carries. Complete snapshot coverage currently expects two independent headers in the legacy split VM/isolate profile; unified and other layouts can yield partial build facts. The snapshot hash maps to a Dart SDK release through an external dataset; REA performs no lookup. No engine, no execution, no external tools.",
    kind: "flutter-provider",
    inputSchema: flutterInputSchemas.identify_flutter_build,
    outputSchema: evidenceResultOf(flutterResultSchemas.identify_flutter_build),
    examples: [
      {
        title: "Identify a Flutter build",
        input: { path: "/targets/Example.apk" },
      },
    ],
  },
  {
    name: "inspect_dart_aot",
    ...toolContractMetadata("inspect_dart_aot"),
    description:
      "Inspect one APK ABI's legacy split VM/isolate Dart AOT snapshot without executing it. Structural coverage supports Dart 2.14 FullAOT kind 3; unified snapshot layouts are unsupported. Returns snapshot exports/headers/hash and bounded package:/dart:/identifier-like byte-pattern strings, not deserialized classes/functions. pool_policy.contains selects strings before collection; other pool budgets do not raise APK/ELF/response limits. Default complete returns all facts; detail summary retains them for inspect_analysis_view kind dart-aot, collections package_uris/dart_uris/class_like_tokens, using parent_evidence_id and row paging. Counts are lower bounds and page exhaustion never proves complete pool coverage.",
    kind: "flutter-provider",
    inputSchema: dartAotInspectionInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        flutterResultSchemas.inspect_dart_aot,
        dartAotSummaryViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Inspect the preferred ABI's AOT snapshot",
        input: { path: "/targets/Example.apk" },
      },
      {
        title: "Inspect one ABI explicitly",
        input: { path: "/targets/Example.apk", abi: "arm64-v8a" },
      },
      {
        title: "Inspect snapshot identity with retained string lists",
        input: { path: "/targets/Example.apk", detail: "summary" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
