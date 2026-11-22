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
import { isImmutableJsonSnapshot } from "../immutableJson.js";
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
      logical_path: true,
      kind: true,
      encrypted: true,
      decoded: true,
      limitations: true,
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

interface PlaywrightTraceIndex {
  readonly eventsById: ReadonlyMap<string, readonly number[]>;
  readonly eventsByStream: ReadonlyMap<string, readonly number[]>;
  readonly eventsByKind: ReadonlyMap<string, readonly number[]>;
  readonly eventsByCall: ReadonlyMap<string, readonly number[]>;
  readonly membersById: ReadonlyMap<string, readonly number[]>;
  readonly membersByPath: ReadonlyMap<string, readonly number[]>;
  readonly streamsById: ReadonlyMap<string, readonly number[]>;
  readonly diagnosticsByCode: ReadonlyMap<string, readonly number[]>;
}

const traceIndexes = new WeakMap<object, PlaywrightTraceIndex>();

const pushBucket = (
  map: Map<string, number[]>,
  key: string | null | undefined,
  index: number,
): void => {
  if (key === null || key === undefined) return;
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = [];
    map.set(key, bucket);
  }
  bucket.push(index);
};

const getPlaywrightTraceIndex = (
  report: PlaywrightTrace,
): PlaywrightTraceIndex | undefined => {
  if (!isImmutableJsonSnapshot(report)) return undefined;
  let cached = traceIndexes.get(report);
  if (cached !== undefined) return cached;
  const eventsById = new Map<string, number[]>();
  const eventsByStream = new Map<string, number[]>();
  const eventsByKind = new Map<string, number[]>();
  const eventsByCall = new Map<string, number[]>();
  for (let index = 0; index < report.events.length; index += 1) {
    const row = report.events[index]!;
    pushBucket(eventsById, row.event_id, index);
    pushBucket(eventsByStream, row.stream_id, index);
    pushBucket(eventsByKind, row.kind, index);
    pushBucket(eventsByCall, row.call_id, index);
  }
  const membersById = new Map<string, number[]>();
  const membersByPath = new Map<string, number[]>();
  for (let index = 0; index < report.members.length; index += 1) {
    const row = report.members[index]!;
    pushBucket(membersById, row.member_id, index);
    pushBucket(membersByPath, row.path, index);
  }
  const streamsById = new Map<string, number[]>();
  for (let index = 0; index < report.streams.length; index += 1)
    pushBucket(streamsById, report.streams[index]!.stream_id, index);
  const diagnosticsByCode = new Map<string, number[]>();
  for (let index = 0; index < report.diagnostics.length; index += 1)
    pushBucket(diagnosticsByCode, report.diagnostics[index]!.code, index);
  cached = {
    eventsById,
    eventsByStream,
    eventsByKind,
    eventsByCall,
    membersById,
    membersByPath,
    streamsById,
    diagnosticsByCode,
  };
  traceIndexes.set(report, cached);
  return cached;
};

const collectCandidateIndices = (
  indexMap: ReadonlyMap<string, readonly number[]>,
  filter: ReadonlySet<string>,
): number[] => {
  if (filter.size === 1) {
    const only = filter.values().next().value;
    const list = only === undefined ? undefined : indexMap.get(only);
    return list === undefined ? [] : [...list];
  }
  const seen = new Set<number>();
  for (const key of filter) {
    const list = indexMap.get(key);
    if (list === undefined) continue;
    for (let i = 0; i < list.length; i += 1) seen.add(list[i]!);
  }
  return [...seen].sort((left, right) => left - right);
};

const selectCandidateRows = <Source, Row>(
  rows: readonly Source[],
  candidateIndices: readonly number[],
  view: { readonly offset: number; readonly limit: number },
  matches: (row: Source, index: number) => boolean,
  project: (row: Source, index: number) => Row,
): { rows: Row[]; total: number } => {
  const selected: Row[] = [];
  let total = 0;
  for (let i = 0; i < candidateIndices.length; i += 1) {
    const index = candidateIndices[i]!;
    const row = rows[index]!;
    if (!matches(row, index)) continue;
    if (total >= view.offset && selected.length < view.limit)
      selected.push(project(row, index));
    total++;
  }
  return { rows: selected, total };
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
    const matchEvent = (row: PlaywrightTrace["events"][number]): boolean =>
      allows(ids, row.event_id) &&
      allows(streams, row.stream_id) &&
      allows(kinds, row.kind) &&
      allows(calls, row.call_id);
    const projectEvent = (row: PlaywrightTrace["events"][number]) =>
      eventFields(row, view);
    if (
      ids !== undefined ||
      streams !== undefined ||
      kinds !== undefined ||
      calls !== undefined
    ) {
      const idx = getPlaywrightTraceIndex(report);
      if (idx !== undefined) {
        const candidates =
          ids !== undefined
            ? collectCandidateIndices(idx.eventsById, ids)
            : calls !== undefined
              ? collectCandidateIndices(idx.eventsByCall, calls)
              : streams !== undefined
                ? collectCandidateIndices(idx.eventsByStream, streams)
                : collectCandidateIndices(idx.eventsByKind, kinds!);
        return selectCandidateRows(
          report.events,
          candidates,
          view,
          matchEvent,
          projectEvent,
        );
      }
    }
    return selectViewRows(report.events, view, matchEvent, projectEvent);
  }
  if (view.collection === "members") {
    const ids = values(view.member_ids),
      paths = values(view.paths);
    const matchMember = (row: PlaywrightTrace["members"][number]): boolean =>
      allows(ids, row.member_id) && allows(paths, row.path);
    const projectMember = (row: PlaywrightTrace["members"][number]) => ({
      ...fields(
        row,
        view.fields ?? ["declared_bytes", "declared_compressed_bytes"],
      ),
      member_id: row.member_id,
      path: row.path,
      logical_path: row.logical_path,
      kind: row.kind,
      encrypted: row.encrypted,
      decoded: row.decoded,
      limitations: row.limitations,
    });
    if (ids !== undefined || paths !== undefined) {
      const idx = getPlaywrightTraceIndex(report);
      if (idx !== undefined) {
        const candidates =
          ids !== undefined
            ? collectCandidateIndices(idx.membersById, ids)
            : collectCandidateIndices(idx.membersByPath, paths!);
        return selectCandidateRows(
          report.members,
          candidates,
          view,
          matchMember,
          projectMember,
        );
      }
    }
    return selectViewRows(report.members, view, matchMember, projectMember);
  }
  if (view.collection === "streams") {
    const ids = values(view.stream_ids);
    const matchStream = (row: PlaywrightTrace["streams"][number]): boolean =>
      allows(ids, row.stream_id);
    const projectStream = (row: PlaywrightTrace["streams"][number]) => ({
      ...fields(row, view.fields ?? ["producer", "lines", "supported_events"]),
      stream_id: row.stream_id,
      member_id: row.member_id,
      role: row.role,
      version: row.version,
      state: row.state,
    });
    if (ids !== undefined) {
      const idx = getPlaywrightTraceIndex(report);
      if (idx !== undefined)
        return selectCandidateRows(
          report.streams,
          collectCandidateIndices(idx.streamsById, ids),
          view,
          matchStream,
          projectStream,
        );
    }
    return selectViewRows(report.streams, view, matchStream, projectStream);
  }
  const codes = values(view.codes);
  const matchDiagnostic = (
    row: PlaywrightTrace["diagnostics"][number],
  ): boolean => allows(codes, row.code);
  const projectDiagnostic = (row: PlaywrightTrace["diagnostics"][number]) => ({
    ...fields(row, view.fields ?? ["message"]),
    diagnostic_id: row.diagnostic_id,
    member_id: row.member_id,
    line: row.line,
    code: row.code,
  });
  if (codes !== undefined) {
    const idx = getPlaywrightTraceIndex(report);
    if (idx !== undefined)
      return selectCandidateRows(
        report.diagnostics,
        collectCandidateIndices(idx.diagnosticsByCode, codes),
        view,
        matchDiagnostic,
        projectDiagnostic,
      );
  }
  return selectViewRows(
    report.diagnostics,
    view,
    matchDiagnostic,
    projectDiagnostic,
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
      coverage: completeWithinViewCoverage(1),
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
