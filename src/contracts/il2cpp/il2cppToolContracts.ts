import { z } from "zod";
import { il2cppMetadataSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  il2cppMetadataSchema,
  inspectIl2cppMetadataInputSchema,
} from "../../domain/il2cpp/il2cppMetadata.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static IL2CPP metadata is independent of native-analysis providers and Unity installations. */
export const IL2CPP_TOOL_CONTRACTS = [
  {
    name: "inspect_il2cpp_metadata",
    ...toolContractMetadata("inspect_il2cpp_metadata"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect Unity IL2CPP metadata versions 24/27/29/31/39, optionally linking a selected 64-bit little-endian Mach-O/PE/ELF binary or an uncompressed Unity WebGL wasm32 module (rows then carry table_index and function_index instead of addresses) without execution. Returns metadata tables and derived native method links; shared addresses retain every method, zero slots mean no-body, and unknown ownership/relocations stay unknown. Default summary retains complete Evidence for inspect_analysis_view kind il2cpp-metadata using parent_evidence_id, named collections, original indices, fields and pages. Unrequested native counts are null; version27 names may be unknown. generic_instances adds supported static registration-table matches for versions 27/29/31. Executable-byte fallback is inferred and does not verify instruction boundaries. Full detail remains available; static agreement proves neither same-build pairing nor runtime behavior. Resource/unsupported-layout failures name their reasons.",
    inputSchema: inspectIl2cppMetadataInputSchema,
    outputSchema: evidenceResultOf(
      z.union([il2cppMetadataSchema, il2cppMetadataSummaryViewResultSchema]),
    ),
    examples: [
      {
        title: "Summarize metadata and retain rows for paging",
        input: {
          path: "/artifacts/Data/Managed/Metadata/global-metadata.dat",
          detail: "summary",
        },
      },
      {
        title: "Link method addresses from a universal macOS binary",
        input: {
          path: "/artifacts/Game.app/Contents/Resources/Data/il2cpp_data/Metadata/global-metadata.dat",
          binary_path:
            "/artifacts/Game.app/Contents/Frameworks/GameAssembly.dylib",
          binary_architecture: "arm64",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
