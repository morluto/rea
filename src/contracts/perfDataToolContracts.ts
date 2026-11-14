import { perfDataSchema } from "../domain/perfData/perfData.js";
import { inspectPerfDataInputSchema } from "../domain/perfData/perfDataQuery.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for one local Linux perf recording. */
export const PERF_DATA_TOOL_CONTRACTS = [
  {
    name: "inspect_perf_data",
    ...toolContractMetadata("inspect_perf_data"),
    kind: "application",
    description:
      "Inventory one local Linux perf recording (perf.data) offline. The file header, its attribute and data section extents, the writer's attribute entry stride, and each event attribute group's type, config, sample type, read format, declared period or frequency, event identifiers and identifier count are reported in file order. Feature payloads and sample/record data are not decoded in this step, so callchains, sampled addresses, module build identities and symbol names are absent; sample settings are the declared sampling configuration, not an execution count or CPU time. Big- and little-endian recordings are both accepted and the order is stated. A truncated header, overlapping sections, an unsupported attribute size or an id array that does not fit the file is reported as a typed diagnostic instead of being repaired. Nothing outside the selected file is read: `perf` is not executed, no target is launched, and no recording-provided content is executed. File and event allowances are 64 MiB and 20000.",
    inputSchema: inspectPerfDataInputSchema,
    outputSchema: evidenceResultOf(perfDataSchema),
    examples: [
      {
        title: "Read a supplied perf recording without a Linux host",
        input: { path: "/artifacts/perf.data" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
