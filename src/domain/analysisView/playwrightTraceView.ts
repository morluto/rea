import {
  analysisTextPage,
  analysisTextPageItemSchema,
} from "./analysisViewText.js";
import { z } from "zod";
import {
  playwrightTraceSchema,
  traceEventSchema,
  traceSourceSchema,
  traceMemberSchema,
  traceStreamSchema,
  traceDiagnosticSchema,
  PLAYWRIGHT_TRACE_OPERATION,
  type PlaywrightTrace,
} from "../playwrightTrace/playwrightTrace.js";
import { playwrightTraceViewRequestSchema } from "../playwrightTrace/playwrightTraceQuery.js";
import type { JsonValue } from "../jsonValue.js";
import { err, ok } from "../result.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  analysisViewCoverageSchema,
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";
import { analysisViewInputError } from "./analysisViewErrors.js";

export const playwrightTraceViewContextSchema = playwrightTraceSchema
  .omit({
    streams: true,
    members: true,
    events: true,
    diagnostics: true,
    limitations: true,
  })
  .extend({
    counts: z.strictObject({
      streams: z.int().nonnegative(),
      members: z.int().nonnegative(),
      diagnostics: z.int().nonnegative(),
    }),
  });
export const playwrightTraceViewItemsSchema = z.union([
  z.array(
    analysisTextPageItemSchema.extend({
      event_id: traceEventSchema.shape.event_id,
      source: traceSourceSchema,
    }),
  ),
  z.array(
    traceEventSchema
      .partial()
      .required({
        event_id: true,
        stream_id: true,
        ordinal: true,
        source: true,
        kind: true,
        credential_redacted: true,
      })
      .extend({
        text_preview: analysisTextPageItemSchema
          .extend({ coverage: analysisViewCoverageSchema })
          .nullable()
          .optional(),
      }),
  ),
  z.array(
    traceMemberSchema.partial().required({
      member_id: true,
      path: true,
      kind: true,
      encrypted: true,
      decoded: true,
    }),
  ),
  z.array(
    traceStreamSchema.partial().required({
      stream_id: true,
      member_id: true,
      role: true,
      version: true,
      state: true,
    }),
  ),
  z.array(
    traceDiagnosticSchema.partial().required({
      diagnostic_id: true,
      member_id: true,
      line: true,
      code: true,
    }),
  ),
]);
const readReport = createAnalysisViewResultReader(playwrightTraceSchema);
const values = (selected: readonly string[] | undefined) =>
  selected === undefined ? undefined : new Set(selected);
const allows = (
  selection: ReadonlySet<string> | undefined,
  value: string | null,
) => selection === undefined || (value !== null && selection.has(value));
const fields = (row: object, selected: readonly string[]) =>
  Object.fromEntries(
    selected.map((key) => [key, (row as Record<string, JsonValue>)[key]!]),
  );
type View = z.output<typeof playwrightTraceViewRequestSchema>;
const eventFields = (
  row: PlaywrightTrace["events"][number],
  view: Extract<View, { collection: "events" }>,
) => {
  const selected = view.fields?.filter((field) => field !== "text_preview") ?? [
    "call_id",
    "page_id",
    "time",
    "method",
    "url",
    "status",
    "selector",
    "resource_references",
  ];
  const preview =
    view.fields === undefined || view.fields.includes("text_preview");
  let text_preview:
    | (z.output<typeof analysisTextPageItemSchema> & {
        coverage: z.output<typeof analysisViewCoverageSchema>;
      })
    | null = null;
  if (preview && row.text !== null) {
    const page = analysisTextPage(row.text, 0, 256, "Recorded event text");
    if (!page.ok) throw page.error;
    text_preview = { ...page.value.item, coverage: page.value.coverage };
  }
  return {
    ...fields(row, selected),
    ...(preview ? { text_preview } : {}),
    event_id: row.event_id,
    stream_id: row.stream_id,
    ordinal: row.ordinal,
    source: row.source,
    kind: row.kind,
    credential_redacted: row.credential_redacted,
  };
};

const selectRows = (
  report: PlaywrightTrace,
  view: Exclude<View, { collection: "event-text" }>,
) => {
  if (view.collection === "events") {
    const ids = values(view.event_ids),
      streams = values(view.stream_ids),
      kinds = values(view.kinds),
      calls = values(view.call_ids);
    return selectViewRows(
      report.events,
      view,
      (row) =>
        allows(ids, row.event_id) &&
        allows(streams, row.stream_id) &&
        allows(kinds, row.kind) &&
        allows(calls, row.call_id),
      (row) => eventFields(row, view),
    );
  }
  if (view.collection === "members") {
    const ids = values(view.member_ids),
      paths = values(view.paths);
    return selectViewRows(
      report.members,
      view,
      (row) => allows(ids, row.member_id) && allows(paths, row.path),
      (row) => ({
        ...fields(
          row,
          view.fields ?? ["declared_bytes", "declared_compressed_bytes"],
        ),
        member_id: row.member_id,
        path: row.path,
        kind: row.kind,
        encrypted: row.encrypted,
        decoded: row.decoded,
      }),
    );
  }
  if (view.collection === "streams") {
    const ids = values(view.stream_ids);
    return selectViewRows(
      report.streams,
      view,
      (row) => allows(ids, row.stream_id),
      (row) => ({
        ...fields(
          row,
          view.fields ?? ["producer", "lines", "supported_events"],
        ),
        stream_id: row.stream_id,
        member_id: row.member_id,
        role: row.role,
        version: row.version,
        state: row.state,
      }),
    );
  }
  const codes = values(view.codes);
  return selectViewRows(
    report.diagnostics,
    view,
    (row) => allows(codes, row.code),
    (row) => ({
      ...fields(row, view.fields ?? ["message"]),
      diagnostic_id: row.diagnostic_id,
      member_id: row.member_id,
      line: row.line,
      code: row.code,
    }),
  );
};
const selectEventText = (
  report: PlaywrightTrace,
  view: Extract<View, { collection: "event-text" }>,
) => {
  const event = report.events.find((row) => row.event_id === view.event_id);
  if (event === undefined || event.text === null)
    return err(
      analysisViewInputError([
        {
          path: ["view", "event_id"],
          reason: "invalid_value",
          message:
            "Choose a retained event with interpreted text; events without a text value remain unknown.",
        },
      ]),
    );
  const page = analysisTextPage(
    event.text,
    view.offset,
    view.limit,
    "Recorded event text",
  );
  if (!page.ok) return page;
  return ok({
    items: [
      { ...page.value.item, event_id: event.event_id, source: event.source },
    ],
    coverage: page.value.coverage,
  });
};

/** Counts do not materialize stream/member/event arrays into the initial agent response. */
export const projectPlaywrightTraceView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView | View>(
    admitted,
    "summary",
    "playwright-trace",
  );
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Playwright trace inventories support summary and playwright-trace pages.",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const {
    streams,
    members,
    events: _events,
    diagnostics,
    limitations,
    ...metadata
  } = parsed.value;
  const context = {
    ...metadata,
    counts: {
      streams: streams.length,
      members: members.length,
      diagnostics: diagnostics.length,
    },
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: PLAYWRIGHT_TRACE_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    limitations: boundedViewMessages(
      [...parent.limitations, ...limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Recording completeness and cross-stream ordering remain unknown. Resource contents are not decoded.",
    ],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      artifact: {
        path: context.artifact.path,
        sha256: context.artifact.sha256,
      },
      summary: context,
      coverage: completeWithinViewCoverage(1, 1),
    });
  if (view.collection === "event-text") {
    const text = selectEventText(parsed.value, view);
    return text.ok
      ? ok({
          ...shared,
          ...context,
          kind: "playwright-trace" as const,
          view,
          ...text.value,
        })
      : text;
  }
  const selected = selectRows(parsed.value, view);
  return ok({
    ...shared,
    ...context,
    kind: "playwright-trace" as const,
    view,
    items: selected.rows,
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
