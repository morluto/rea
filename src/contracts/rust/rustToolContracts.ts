import { rustBinarySchema } from "../../domain/rust/rustBinary.js";
import { inspectRustBinaryRequestSchema } from "../../domain/rust/rustBinaryQuery.js";
import { z } from "zod";
import {
  rustBinarySummaryViewResultSchema,
  rustBinaryPageViewResultSchema,
} from "../../domain/analysisView/analysisViewResult.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static Rust dependency metadata is independent of active native-analysis providers. */
export const RUST_TOOL_CONTRACTS = [
  {
    name: "inspect_rust_binary",
    ...toolContractMetadata("inspect_rust_binary"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Read the embedded cargo-auditable crate dependencies of a local ELF, PE or selected Mach-O slice without running it or requiring Rust. Returns artifact identity, source ranges, ordered packages and dependency edges. Missing metadata does not prove no dependencies; a rustc commit from an observed source path is inferred. Default complete returns the report; detail summary retains it for inspect_analysis_view kind rust, collections packages/edges, via parent_evidence_id. Optional view selects a page in this call and cannot accompany explicit complete detail. Original row indices and every matching version survive selection; select dependencies explicitly for package dependency vectors. Runtime dependencies remain unknown; malformed or oversized inputs fail rather than return partial success.",
    inputSchema: inspectRustBinaryRequestSchema,
    outputSchema: evidenceResultOf(
      z.union([
        rustBinarySchema,
        rustBinarySummaryViewResultSchema,
        rustBinaryPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Inspect an embedded Rust dependency list",
        input: { path: "/artifacts/application" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
