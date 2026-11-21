import {
  evtxArchiveCompleteDeliveryShape,
  evtxArchiveSummaryDeliveryShape,
} from "../domain/analysisView/evtxArchiveView.js";
import { evtxArchiveSummaryViewResultSchema } from "../domain/analysisView/analysisViewResult.js";
import { evtxArchiveSchema } from "../domain/evtxArchive/evtxArchive.js";
import { inspectEvtxArchiveInputSchema } from "../domain/evtxArchive/evtxArchiveQuery.js";
import { presentRootDiscriminator } from "../domain/schemaAnnotations.js";
import { analysisDetailOutputSchemaOf } from "./analysisDetail.js";
import { evidenceEffects, toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";
import { z } from "zod";

/** Delivery selection does not change provider inputs or complete Evidence identity. */
export const inspectEvtxArchiveRequestSchema = presentRootDiscriminator(
  z.discriminatedUnion("detail", [
    inspectEvtxArchiveInputSchema.extend(evtxArchiveCompleteDeliveryShape),
    inspectEvtxArchiveInputSchema.extend(evtxArchiveSummaryDeliveryShape),
  ]),
  "detail",
);

/** Named, provider-free contract for records in one local Windows event log. */
export const EVTX_ARCHIVE_TOOL_CONTRACTS = [
  {
    name: "inspect_evtx_archive",
    cli: true,
    ...toolContractMetadata("inspect_evtx_archive", evidenceEffects),
    kind: "application",
    description:
      "Inventory the records of one local Windows Event Log (.evtx) file offline. File and chunk headers, chunk numbers, record numbers, record-header timestamps and declared record sizes are reported in file order. Chunk header checksums are evaluated and a mismatch is reported rather than corrected. Embedded event XML is not decoded in this step, so channel, provider, event ID, level and EventData values are absent; typed payload values and event templates are not resolved. Truncated and undecodable records remain explicit diagnostics, and a short or wrapped chunk does not discard the events it produced. Default complete returns full Evidence; detail summary retains it and returns header and coverage counts through inspect_analysis_view. Nothing outside the selected file is read: no live Event Log service is contacted and no event-provided content is executed. File and record allowances are 64 MiB and 20000.",
    inputSchema: inspectEvtxArchiveRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      evtxArchiveSchema,
      evtxArchiveSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Read a supplied event log without a Windows host",
        input: { path: "/artifacts/Security.evtx" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
