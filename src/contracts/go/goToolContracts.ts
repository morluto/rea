import {
  goBinarySchema,
  inspectGoBinaryInputSchema,
} from "../../domain/go/goBinary.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { analysisDetailOutputSchemaOf } from "../analysisDetail.js";
import { goBinarySummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";

/** Static Go metadata is independent of active native-analysis providers and host toolchains. */
export const GO_TOOL_CONTRACTS = [
  {
    name: "inspect_go_binary",
    ...toolContractMetadata("inspect_go_binary"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect embedded Go compiler version, main module, dependency/replacement versions, build settings and optional inferred static (ptr, len) UTF-8 string literals in an explicit local ELF, PE or thin Mach-O image, or the slice of a universal Mach-O named by architecture (read without lipo; artifact stays the universal file, selected_slice records the slice and source ranges stay file offsets). Default detail complete returns original artifact SHA-256, exact build-info source ranges, raw framed module bytes and unparsed module-text lines inline as observed Evidence; include_string_literals: true adds bounded deduplicated string_literals (default max_string_literals 2,000, max_string_literal_bytes 4,096, max_string_bytes 512 KiB, max_string_header_scan_bytes 64 MiB and max_string_candidates 100,000; each budget is selectable per call) recovered from word-aligned (ptr, len) headers in non-executable mapped data pointing within single read-only spans. Explicit detail summary retains the same complete parent and returns compiler/main-module identity, counts, source ranges and parent_evidence_id. Query retained rows through inspect_analysis_view kind go, collection dependencies, settings or string_literals (exact values or substring contains when collected); select indices, fields and pagination. Rows always retain their original index scoped to the parent Evidence; empty filters select none. Runtime dependency completeness and string reachability remain unknown. Supports inline and historical pointer encodings without installing Go, opening a disassembler, executing the target, writing temporary files or accessing the network. Missing metadata is reported as unknown, not proof that an image is not Go. Does not recover functions, source mappings, types or runtime behavior. Per-call max_input_bytes defaults to 256 MiB, max_header_search_bytes to 256 MiB of cumulative distinct search-span work (partial overlaps charged separately), max_build_info_bytes to 1 MiB and max_report_bytes to 8 MiB. Increase the exact reported request budget and retry the same complete artifact without restarting; these controls do not raise MCP delivery limits or the separate 16 MiB structural decoding boundary. Malformed, unsupported and oversized inputs receive typed failures rather than partial success.",
    inputSchema: inspectGoBinaryInputSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      goBinarySchema,
      goBinarySummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect embedded build provenance",
        input: { path: "/artifacts/application" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
