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
] as const satisfies readonly ToolContract[];
