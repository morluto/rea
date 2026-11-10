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
      "Inspect a caller-selected Playwright v10 trace ZIP offline. No browser, replay or recorded-URL requests. Retains action boundaries, console text, network facts and screenshot/body references with archive/member/line identity. No cross-stream total order or complete-capture claim. Credentials use existing HAR/URL projection; context options, most action arguments/results, DOM and resource bytes are not analyzed. Default summary retains complete supported Evidence; view selects events/streams/members/diagnostics with batch IDs, fields and paging. Default text previews cover 256 UTF-16 units; event-text reads further exact text chunks and fields text returns the complete value. Archive/decoded-stream/fact allowances are 256/32/32 MiB; individual lines 4 MiB with bounded JSON node admission. One archive import is admitted at a time per decoder; retained views remain independent. Paging does not increase parsing allowances.",
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
