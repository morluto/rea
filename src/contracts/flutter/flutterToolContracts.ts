import {
  flutterInputSchemas,
  flutterResultSchemas,
} from "../../domain/flutter/flutterBuildAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Flutter build identification by pure APK parsing. */
export const FLUTTER_TOOL_CONTRACTS = [
  {
    name: "identify_flutter_build",
    ...toolContractMetadata("identify_flutter_build"),
    description:
      "Identify a Flutter app's build facts by pure parsing: the Dart VM snapshot hash from every lib/<abi>/libapp.so AOT section (vm and isolate, cross-checked), per-ABI library digests, the engine library's GNU build-id, and any labeled Dart version or toolchain strings libflutter.so carries. The snapshot hash is the artifact that maps to a Dart SDK release through an external dataset; REA performs no lookup. No engine, no execution, no external tools.",
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
      "Inspect one ABI's Dart AOT snapshot inside an APK: the four snapshot symbols located through the ELF dynamic symbol table with their offsets, sizes, and section headers (magic, kind, length), the snapshot hash, and a bounded string-pool projection from the isolate data section (package: source URIs, dart: SDK URIs, identifier-like tokens) exposing the app's dependency structure. String-pool entries are byte-pattern observations, not deserialized cluster semantics; typed class and function recovery needs an SDK-specific parser. No engine, no execution.",
    kind: "flutter-provider",
    inputSchema: flutterInputSchemas.inspect_dart_aot,
    outputSchema: evidenceResultOf(flutterResultSchemas.inspect_dart_aot),
    examples: [
      {
        title: "Inspect the preferred ABI's AOT snapshot",
        input: { path: "/targets/Example.apk" },
      },
      {
        title: "Inspect one ABI explicitly",
        input: { path: "/targets/Example.apk", abi: "arm64-v8a" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
