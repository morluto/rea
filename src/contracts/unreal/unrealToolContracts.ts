import { z } from "zod";
import { unrealPakSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  inspectUnrealPakInputSchema,
  unrealPakSchema,
} from "../../domain/unreal/unrealPak.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static pak indexes are independent of native-analysis providers and Unreal installations. */
export const UNREAL_TOOL_CONTRACTS = [
  {
    name: "inspect_unreal_pak",
    ...toolContractMetadata("inspect_unreal_pak"),
    kind: "artifact-provider",
    description:
      "Inspect an explicit local Unreal Engine .pak file (pak versions 1 to 12) and return its footer (version, index region and SHA-1, index encryption flag, key GUID, compression method names) and every index entry: path, offset, size, uncompressed size, compression method, block count and size, encryption and deletion flags, and the SHA-1 stored with full records. Only the footer and index regions are read, so multi-gigabyte paks are inspected without loading them; the whole file is still hashed for artifact identity. By default retains the complete Evidence and returns footer, index facts and entry and issue counts; select entries with inspect_analysis_view kind unreal-pak and normalized_result.parent_evidence_id by exact indices or paths, with fields and paging. Filters intersect and empty arrays select none; each row keeps its original entry index and page offsets count matching rows in index order. detail complete returns every entry inline. Does not extract, decompress or decrypt file data, accepts no key, and does not attribute the pak version to an engine release. An encrypted index is reported as encrypted with footer facts only. Contradicting redundant facts keep decoding and are returned as issues with kind, file offset and message: index regions that fail their recorded SHA-1, repeated paths or path hashes (every entry kept), entry counts the listings disagree on (entry_count null), compression slots the footer leaves empty for a referenced record (compression_name null), directory names without a closing slash (path null) and, in version 11+, directory index paths whose hash the path hash index does not map to the same record (path null); the summary counts them and inspect_analysis_view collection issues selects them by indices, kinds and fields. Unrecognized footers and version 9 frozen indexes are unsupported; structure that cannot be trusted for further reads (truncated records, out-of-file regions, invalid strings or flags, trailing index bytes, dangling entry references, entries ending past the data area) is rejected with a reason and no partial success. Resource guards bound the index regions of one pak to 256 MiB together, entries to 1,000,000, built path text to 67,108,864 UTF-16 code units and the complete report to 64 MiB, with one active inspection per reader.",
    inputSchema: inspectUnrealPakInputSchema,
    outputSchema: evidenceResultOf(
      z.union([unrealPakSchema, unrealPakSummaryViewResultSchema]),
    ),
    examples: [
      {
        title: "Summarize a pak index and retain entries for selection",
        input: { path: "/artifacts/Content/Paks/Game-Windows.pak" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
