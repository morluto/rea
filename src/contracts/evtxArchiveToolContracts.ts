import { evtxArchiveSchema } from "../domain/evtxArchive/evtxArchive.js";
import { inspectEvtxArchiveInputSchema } from "../domain/evtxArchive/evtxArchiveQuery.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for records in one local Windows event log. */
export const EVTX_ARCHIVE_TOOL_CONTRACTS = [
  {
    name: "inspect_evtx_archive",
    ...toolContractMetadata("inspect_evtx_archive"),
    kind: "application",
    description:
      "Inventory the records of one local Windows Event Log (.evtx) file offline. File and chunk headers, chunk numbers, record numbers, record-header timestamps and declared record sizes are reported in file order. Chunk header checksums are evaluated and a mismatch is reported rather than corrected. Embedded event XML is not decoded in this step, so channel, provider, event ID, level and EventData values are absent; typed payload values and event templates are not resolved. Truncated and undecodable records remain explicit diagnostics, and a short or wrapped chunk does not discard the events it produced. Nothing outside the selected file is read: no live Event Log service is contacted and no event-provided content is executed. File and record allowances are 64 MiB and 20000.",
    inputSchema: inspectEvtxArchiveInputSchema,
    outputSchema: evidenceResultOf(evtxArchiveSchema),
    examples: [
      {
        title: "Read a supplied event log without a Windows host",
        input: { path: "/artifacts/Security.evtx" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
