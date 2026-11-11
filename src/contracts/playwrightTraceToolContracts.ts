import { z } from "zod";
import { playwrightTraceSchema } from "../domain/playwrightTrace/playwrightTrace.js";
import { inspectPlaywrightTraceInputSchema } from "../domain/playwrightTrace/playwrightTraceQuery.js";
import {
  playwrightTraceSummaryViewResultSchema,
  playwrightTracePageViewResultSchema,
} from "../domain/analysisView/analysisView.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

export const PLAYWRIGHT_TRACE_TOOL_CONTRACTS = [
  {
    name: "inspect_playwright_trace",
    ...toolContractMetadata("inspect_playwright_trace"),
    kind: "application",
    description:
      'Inspect a local Playwright v10 trace ZIP offline, without browser replay or requests to recorded URLs. Returns action boundaries, console/network facts, screenshot/body references and archive/member/line provenance; no cross-stream total order or complete-capture claim. Context options, most action arguments/results, DOM and resource bytes are not analyzed; credentials use HAR/URL projection. Default summary retains supported Evidence. Use view {kind:"playwright-trace",collection:"events",kinds:["network"],limit:10}, or streams/members/diagnostics pages. Text previews cover 256 UTF-16 units; event-text with exact event_id reads further chunks, and fields ["text"] selects full text. Paging does not raise parsing allowances; one archive import is admitted per decoder while retained views remain independent.',
    inputSchema: inspectPlaywrightTraceInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        playwrightTraceSchema,
        playwrightTraceSummaryViewResultSchema,
        playwrightTracePageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Read recorded network headlines without contacting endpoints",
        input: {
          path: "/captures/trace.zip",
          view: {
            kind: "playwright-trace",
            collection: "events",
            kinds: ["network"],
            limit: 10,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
