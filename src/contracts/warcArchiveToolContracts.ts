import { warcArchiveSchema } from "../domain/warcArchive/warcArchive.js";
import { inspectWarcArchiveInputSchema } from "../domain/warcArchive/warcArchiveQuery.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for records in one local WARC archive. */
export const WARC_ARCHIVE_TOOL_CONTRACTS = [
  {
    name: "inspect_warc_archive",
    ...toolContractMetadata("inspect_warc_archive"),
    kind: "application",
    description:
      "Inventory the records of one local WARC or WARC.gz archive offline. Record headers, WARC-Record-ID, dates, target URIs, declared content lengths, digests and record types are reported in archive order; unknown record types stay listed instead of being dropped. Response records also carry their embedded HTTP status line. Record payloads, further HTTP headers and bodies are not decoded, declared digests are not verified, and records are not linked to each other. Nothing outside the selected file is read: no target is fetched and no archived script, link or resource is executed. Truncated records, malformed headers and invalid lengths remain explicit diagnostics. File and decoded-stream allowances are 64 MiB and 256 MiB; the record allowance is 20000.",
    inputSchema: inspectWarcArchiveInputSchema,
    outputSchema: evidenceResultOf(warcArchiveSchema),
    examples: [
      {
        title: "Read a crawl archive's records without replaying its traffic",
        input: { path: "/artifacts/crawl.warc.gz" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
